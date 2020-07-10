import * as streams from 'stream';
import * as http2 from 'http2';

import { getLocal } from "../..";
import { expect, nodeOnly, delay } from "../test-utils";

type Http2ResponseHeaders = http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;

function getResponse(req: http2.ClientHttp2Stream) {
    return new Promise<Http2ResponseHeaders>((resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
    });
}

function getBody(req: http2.ClientHttp2Stream) {
    return new Promise<Buffer>((resolve, reject) => {
        const body: Buffer[] = [];
        req.on('data', (d: Buffer | string) => {
            body.push(Buffer.from(d));
        });
        req.on('end', () => req.close());
        req.on('close', () => resolve(Buffer.concat(body)));
        req.on('error', reject);
    });
}

async function cleanup(...streams: (streams.Duplex | http2.Http2Session)[]) {
    for (let stream of streams) {
        if ('close' in stream) {
            let session = stream;
            await new Promise((resolve) => {
                session.close(resolve);
            });
            await delay(10); // Close isn't instant, there can be races here
        }
        else {
            stream.destroy();
        }
    }
}

nodeOnly(() => {
    describe("Using Mockttp with HTTP/2", function () {

        describe("without TLS", () => {

            const server = getLocal();

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("can respond to direct HTTP/2 requests", async () => {
                await server.get('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2c'); // Plaintext HTTP/2

                const responseBody = await getBody(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");

                await cleanup(client);
            });

            it("can respond to proxied HTTP/2 requests", async () => {
                await server.get('http://example.com/mocked-endpoint')
                    .thenReply(200, "Proxied HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request({
                    ':method': 'CONNECT',
                    ':authority': 'example.com:80'
                });

                // Initial response, the proxy has set up our tunnel:
                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                // We can now read/write to req as a raw TCP socket to example.com:
                const proxiedClient = http2.connect('http://example.com', {
                     // Tunnel this request through the proxy stream
                    createConnection: () => req
                });

                const proxiedRequest = proxiedClient.request({
                    ':path': '/mocked-endpoint'
                });
                const proxiedResponse = await getResponse(proxiedRequest);
                expect(proxiedResponse[':status']).to.equal(200);

                const responseBody = await getBody(proxiedRequest);
                expect(responseBody.toString('utf8')).to.equal("Proxied HTTP2 response!");

                await cleanup(proxiedClient, client);
            });

        });

        describe("with TLS", () => {

            const server = getLocal({
                https: {
                    keyPath: './test/fixtures/test-ca.key',
                    certPath: './test/fixtures/test-ca.pem'
                }
            });

            beforeEach(() => server.start());
            afterEach(() => server.stop());

            it("can respond to direct HTTP/2 requests", async () => {
                server.get('/').thenReply(200, "HTTP2 response!");

                const client = http2.connect(server.url);

                const req = client.request();

                const responseHeaders = await getResponse(req);
                expect(responseHeaders[':status']).to.equal(200);

                expect(client.alpnProtocol).to.equal('h2'); // HTTP/2 over TLS

                const responseBody = await getBody(req);
                expect(responseBody.toString('utf8')).to.equal("HTTP2 response!");

                await cleanup(client);
            });

        });

    });
});