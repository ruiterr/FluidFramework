import * as resources from "gitresources";
import cloneDeep = require("lodash/cloneDeep");
import performanceNow = require("performance-now");
import * as request from "request";
import * as io from "socket.io-client";
import * as api from "../api-core";
import { GitManager } from "../git-storage";
import { DocumentStorageService } from "./blobStorageService";
import { debug } from "./debug";
import { DocumentDeltaStorageService } from "./deltaStorageService";
import { DocumentDeltaConnection } from "./documentDeltaConnection";
import * as messages from "./messages";

// Type aliases for mapping from events, to the objects interested in those events, to the connections for those
// objects
type ConnectionMap = { [connectionId: string]: api.IDocumentDeltaConnection };
type ObjectMap = { [objectId: string]: ConnectionMap };
type EventMap = { [event: string]: ObjectMap };

export function getEmptyHeader(id: string): api.IDocumentHeader {
    const emptyHeader: api.IDocumentHeader = {
        attributes: {
            branch: id,
            minimumSequenceNumber: 0,
            sequenceNumber: 0,
        },
        distributedObjects: [],
        transformedMessages: [],
        tree: null,
    };

    return emptyHeader;
}

export class DocumentResource implements api.IDocumentResource {
    constructor(
        public documentId: string,
        public clientId: string,
        public existing: boolean,
        public version: resources.ICommit,
        public parentBranch: string,
        public deltaConnection: api.IDocumentDeltaConnection,
        public documentStorageService: api.IDocumentStorageService,
        public deltaStorageService: api.IDocumentDeltaStorageService,
        public distributedObjects: api.IDistributedObject[],
        public pendingDeltas: api.ISequencedDocumentMessage[],
        public transformedMessages: api.ISequencedDocumentMessage[],
        public snapshotOriginBranch: string,
        public sequenceNumber: number,
        public minimumSequenceNumber: number,
        public tree: api.ISnapshotTree) {
    }
}

/**
 * The DocumentService manages the Socket.IO connection and manages routing requests to connected
 * clients
 */
export class DocumentService implements api.IDocumentService {
    private eventMap: EventMap = {};
    private socket;

    constructor(
        private url: string,
        private deltaStorage: api.IDeltaStorageService,
        private blobStorge: api.IBlobStorageService,
        private gitManager: GitManager) {

        debug(`Creating document service ${performanceNow()}`);
        this.socket = io(url, { transports: ["websocket"] });
    }

    public async connect(
        id: string,
        version: resources.ICommit,
        connect: boolean,
        encrypted: boolean): Promise<api.IDocumentResource> {

        debug(`Connecting to ${id} - ${performanceNow()}`);

        // Generate encryption keys for new connection.
        let privateKey: string = null;
        let publicKey: string = null;

        // if (encrypted) {
        //     const asymmetricKeys = await api.generateAsymmetricKeys(2048, "", id);
        //     privateKey = asymmetricKeys.privateKey;
        //     publicKey = asymmetricKeys.publicKey;
        // }

        const connectMessage: messages.IConnect = { id, privateKey, publicKey, encrypted };

        // If a version is specified we will load it directly - otherwise will query historian for the latest
        // version and then load it
        if (version === undefined) {
            const commits = await this.gitManager.getCommits(id, 1);
            version = commits.length > 0 ? commits[0] : null;
        }

        // Load in the header for the version. At this point if version is still null that means there are no
        // snapshots and we should start with an empty header.
        const headerP = version
            ? this.blobStorge.getHeader(id, version)
            : Promise.resolve(getEmptyHeader(id));

        const connectionP = new Promise<messages.IConnected>((resolve, reject) => {
            this.socket.emit(
                "connectDocument",
                connectMessage,
                (error, response: messages.IConnected) => {
                    if (error) {
                        return reject(error);
                    } else {
                        return resolve(response);
                    }
                });
        });
        const pendingDeltasP = headerP.then((header) => {
            return this.deltaStorage.get(id, header ? header.attributes.sequenceNumber : 0);
        });

        // header *should* be enough to return the document. Pull it first as well as any pending delta
        // messages which should be taken into account before client logic.

        const [header, connection, pendingDeltas] = await Promise.all([headerP, connectionP, pendingDeltasP]);

        debug(`Connected to ${id} - ${performanceNow()}`);
        const deltaConnection = new DocumentDeltaConnection(
            this,
            id,
            connection.clientId,
            encrypted,
            connection.privateKey,
            connection.publicKey);
        const deltaStorage = new DocumentDeltaStorageService(id, this.deltaStorage);
        const documentStorage = new DocumentStorageService(id, version, this.blobStorge);

        const document = new DocumentResource(
            id,
            connection.clientId,
            connection.existing,
            version,
            connection.parentBranch,
            deltaConnection,
            documentStorage,
            deltaStorage,
            header.distributedObjects,
            pendingDeltas,
            header.transformedMessages,
            header.attributes.branch,
            header.attributes.sequenceNumber,
            header.attributes.minimumSequenceNumber,
            header.tree);
        return document;
    }

    public async branch(id: string): Promise<string> {
        const forkId = await this.createFork(id);
        return forkId;
    }

    /**
     * Emits a message on the socket
     */
    public emit(event: string, ...args: any[]) {
        this.socket.emit(event, ...args);
    }

    /**
     * Registers the given connection to receive events of the given type
     */
    public registerForEvent(event: string, connection: api.IDocumentDeltaConnection) {
        // See if we're already listening for the given event - if not start
        if (!(event in this.eventMap)) {
            this.eventMap[event] = {};
            this.socket.on(
                event,
                (documentId: string, message: any) => {
                    this.handleMessage(event, documentId, message);
                });
        }

        // Register the object for the given event
        const objectMap = this.eventMap[event];
        if (!(connection.documentId in objectMap)) {
            objectMap[connection.documentId] = {};
        }

        // And finally store the connection as interested in the given event
        objectMap[connection.documentId][connection.clientId] = connection;
    }

    /**
     * Handles a message received from the other side of the socket. This message routes it to the connection
     * that has registered to receive events of that type.
     */
    private handleMessage(event: string, documentId: string, message: any) {
        const objectMap = this.eventMap[event];
        if (!objectMap) {
            return;
        }

        const connectionMap = objectMap[documentId];
        if (!connectionMap) {
            return;
        }

        // Route message to all registered clients
        for (const clientId in connectionMap) {
            if (connectionMap[clientId]) {
                const clone = cloneDeep(message);
                connectionMap[clientId].dispatchEvent(event, clone);
            }
        }
    }

    private createFork(id: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            request.post(
                { url: `${this.url}/documents/${id}/forks`, json: true },
                (error, response, body) => {
                    if (error) {
                        reject(error);
                    } else if (response.statusCode !== 201) {
                        reject(response.statusCode);
                    } else {
                        resolve(body);
                    }
                });
        });
    }
}
