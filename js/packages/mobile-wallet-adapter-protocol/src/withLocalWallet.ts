import createHelloReq from './createHelloReq';
import {
    SolanaMobileWalletAdapterProtocolJsonRpcError,
    SolanaMobileWalletAdapterProtocolSessionClosedError,
    SolanaMobileWalletAdapterProtocolSessionEstablishmentError,
} from './errors';
import generateAssociationKeypair from './generateAssociationKeypair';
import generateECDHKeypair from './generateECDHKeypair';
import { decryptJsonRpcMessage, encryptJsonRpcMessage } from './jsonRpcMessage';
import parseHelloRsp, { SharedSecret } from './parseHelloRsp';
import { startSession } from './startSession';
import { AssociationKeypair, MobileWallet } from './types';

const WEBSOCKET_PROTOCOL = 'com.solana.mobilewalletadapter.v1';

type JsonResponsePromises<T> = Record<
    number,
    Readonly<{ resolve: (value?: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void }>
>;

type State =
    | { __type: 'connected'; sharedSecret: SharedSecret }
    | { __type: 'connecting'; associationKeypair: AssociationKeypair }
    | { __type: 'disconnected' }
    | { __type: 'hello_req_sent'; associationPublicKey: CryptoKey; ecdhPrivateKey: CryptoKey };

export default async function withLocalWallet<TReturn>(callback: (wallet: MobileWallet) => TReturn): Promise<TReturn> {
    const associationKeypair = await generateAssociationKeypair();
    const sessionPort = await startSession(associationKeypair.publicKey);
    const websocketURL = `ws://localhost:${sessionPort}/solana-wallet`;
    let nextJsonRpcMessageId = 1;
    let state: State = { __type: 'disconnected' };
    return new Promise((resolve, reject) => {
        let attempts = 0;
        let socket: WebSocket;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const jsonRpcResponsePromises: JsonResponsePromises<any> = {};
        const handleOpen = async () => {
            if (state.__type !== 'connecting') {
                console.warn(
                    'Expected adapter state to be `connecting` at the moment the websocket opens. ' +
                        `Got \`${state.__type}\`.`,
                );
                return;
            }
            const { associationKeypair } = state;
            socket.removeEventListener('open', handleOpen);
            const ecdhKeypair = await generateECDHKeypair();
            socket.send(await createHelloReq(ecdhKeypair.publicKey, associationKeypair.privateKey));
            state = {
                __type: 'hello_req_sent',
                associationPublicKey: associationKeypair.publicKey,
                ecdhPrivateKey: ecdhKeypair.privateKey,
            };
        };
        const handleClose = (evt: CloseEvent) => {
            if (evt.wasClean) {
                state = { __type: 'disconnected' };
            } else {
                reject(new SolanaMobileWalletAdapterProtocolSessionClosedError(evt.code, evt.reason));
            }
            disposeSocket();
        };
        const handleError = (_evt: Event) => {
            disposeSocket();
            if (++attempts >= 100) {
                reject(new SolanaMobileWalletAdapterProtocolSessionEstablishmentError(sessionPort));
            } else {
                attemptSocketConnection();
            }
        };
        const handleMessage = async (evt: MessageEvent<Blob>) => {
            const responseBuffer = await evt.data.arrayBuffer();
            switch (state.__type) {
                case 'connected':
                    try {
                        const jsonRpcMessage = await decryptJsonRpcMessage(responseBuffer, state.sharedSecret);
                        const responsePromise = jsonRpcResponsePromises[jsonRpcMessage.id];
                        delete jsonRpcResponsePromises[jsonRpcMessage.id];
                        responsePromise.resolve(jsonRpcMessage.result);
                    } catch (e) {
                        if (e instanceof SolanaMobileWalletAdapterProtocolJsonRpcError) {
                            const responsePromise = jsonRpcResponsePromises[e.jsonRpcMessageId];
                            delete jsonRpcResponsePromises[e.jsonRpcMessageId];
                            responsePromise.reject(e);
                        } else {
                            throw e;
                        }
                    }
                    break;
                case 'hello_req_sent': {
                    const sharedSecret = await parseHelloRsp(
                        responseBuffer,
                        state.associationPublicKey,
                        state.ecdhPrivateKey,
                    );
                    state = { __type: 'connected', sharedSecret };
                    const wallet: MobileWallet = async (method, params) => {
                        const id = nextJsonRpcMessageId++;
                        socket.send(
                            await encryptJsonRpcMessage(
                                {
                                    id,
                                    jsonrpc: '2.0',
                                    method,
                                    params,
                                },
                                sharedSecret,
                            ),
                        );
                        return new Promise((resolve, reject) => {
                            jsonRpcResponsePromises[id] = { resolve, reject };
                        });
                    };
                    try {
                        resolve(await callback(wallet));
                    } catch (e) {
                        reject(e);
                    } finally {
                        disposeSocket();
                        socket.close();
                    }
                    break;
                }
            }
        };
        let disposeSocket: () => void;
        const attemptSocketConnection = () => {
            if (disposeSocket) {
                disposeSocket();
            }
            state = { __type: 'connecting', associationKeypair };
            socket = new WebSocket(websocketURL, [WEBSOCKET_PROTOCOL]);
            socket.addEventListener('open', handleOpen);
            socket.addEventListener('close', handleClose);
            socket.addEventListener('error', handleError);
            socket.addEventListener('message', handleMessage);
            disposeSocket = () => {
                socket.removeEventListener('open', handleOpen);
                socket.removeEventListener('close', handleClose);
                socket.removeEventListener('error', handleError);
                socket.removeEventListener('message', handleMessage);
            };
        };
        attemptSocketConnection();
    });
}
