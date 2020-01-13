/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    IDatabaseManager,
    IDocumentStorage,
    ITaskMessageSender,
    ITenantManager,
    IWebSocketServer,
} from "@microsoft/fluid-server-services-core";
// eslint-disable-next-line import/no-internal-modules
import * as uuid from "uuid/v4";
import { IConcreteNodeFactory } from "./interfaces";
import { LocalNode } from "./localNode";

export class LocalNodeFactory implements IConcreteNodeFactory {
    constructor(
        private readonly hostname: string,
        private readonly address: string,
        private readonly storage: IDocumentStorage,
        private readonly databaseManager: IDatabaseManager,
        private readonly timeoutLength: number,
        private readonly webSocketServerFactory: () => IWebSocketServer,
        private readonly taskMessageSender: ITaskMessageSender,
        private readonly tenantManager: ITenantManager,
        private readonly permission: any,
        private readonly maxMessageSize: number) {
    }

    public async create(): Promise<LocalNode> {
        const node = LocalNode.connect(
            `${this.hostname}-${uuid()}`,
            this.address,
            this.storage,
            this.databaseManager,
            this.timeoutLength,
            this.webSocketServerFactory,
            this.taskMessageSender,
            this.tenantManager,
            this.permission,
            this.maxMessageSize);

        return node;
    }
}