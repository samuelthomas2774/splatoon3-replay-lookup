import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Storage, LocalStorageProvider, Users, ErrorResponse, version, addUserAgent } from 'nxapi';
import { RequestIdSymbol, SplatNet3 } from 'nxapi/splatnet3';
import createDebug from 'debug';
import { DownloadSearchReplayResult, RequestId } from 'splatnet3-types/splatnet3';
import express, { Request, Response } from 'express';
import persist from 'node-persist';

interface ReplayData {
    replay: DownloadSearchReplayResult['replay'] | null;
    request_id: string;
    created_at: number;
}

const debug = createDebug('splatoon3-replay-lookup');

const product = 'splatoon3-replay-lookup/0.3.0';
addUserAgent(product);

const REPLAY_CODE_REGEX = /^[A-Z0-9]{16}$/;

const ResourceUrlMapSymbol = Symbol('ResourceUrls');

class Server {
    readonly app: express.Express;

    readonly promise = new Map<string, Promise<ReplayData>>();
    readonly promise_image = new Map<string, Promise<string>>();

    constructor(
        readonly splatnet: SplatNet3,
        readonly cache: persist.LocalStorage,
    ) {
        const app = express();

        app.use('/api/splatnet3', (req, res, next) => {
            console.log('[%s] %s %s HTTP/%s from %s, port %d%s, %s',
                new Date(), req.method, req.url, req.httpVersion,
                req.socket.remoteAddress, req.socket.remotePort,
                req.headers['x-forwarded-for'] ? ' (' + req.headers['x-forwarded-for'] + ')' : '',
                req.headers['user-agent']);

            res.setHeader('Server', 'nxapi/' + version + ' ' + product);
            res.setHeader('X-Server', 'nxapi/' + version + ' ' + product);
            res.setHeader('X-Served-By', os.hostname());

            next();
        });

        app.use('/api/splatnet3/resources', express.static(fileURLToPath(
            new URL('../data/resources', import.meta.url)), {redirect: false}));

        app.get('/api/splatnet3/replay/:code', this.createApiRequestHandler((req, res) =>
            this.handleReplayRequest(req, res, req.params.code)));

        this.app = app;
    }

    protected createApiRequestHandler(callback: (req: Request, res: Response) => Promise<{} | void>) {
        return async (req: Request, res: Response) => {
            try {
                const result = await callback.call(null, req, res);

                if (result) this.sendJsonResponse(res, result);
                else res.end();
            } catch (err) {
                this.handleRequestError(req, res, err);
            }
        };
    }

    protected sendJsonResponse(res: Response, data: {}, status?: number) {
        if (status) res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(this.encodeJsonForResponse(data, res.req.headers['accept']?.match(/\/html\b/i) ? 4 : 0));
    }

    protected encodeJsonForResponse(data: unknown, space?: number) {
        const url_map = data && typeof data === 'object' && ResourceUrlMapSymbol in data &&
            data[ResourceUrlMapSymbol] && typeof data[ResourceUrlMapSymbol] === 'object' ?
                data[ResourceUrlMapSymbol] as Partial<Record<string, string>> : null;

        return JSON.stringify(data, (key: string, value: unknown) => {
            if (typeof value === 'object' && value && 'url' in value && typeof value.url === 'string') {
                return {
                    ...value,
                    url: url_map?.[value.url] ?? value.url,
                };
            }

            return value;
        }, space);
    }

    protected handleRequestError(req: Request, res: Response, err: unknown) {
        debug('Error in request %s %s', req.method, req.url, err);

        if (err instanceof ResponseError) {
            err.sendResponse(req, res);
        } else {
            this.sendJsonResponse(res, {
                error: 'unknown_error',
                error_message: (err as Error).message,
                error_data: err,
            }, 500);
        }
    }

    async handleReplayRequest(req: Request, res: Response, code: string) {
        code = code.replace(/^([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/, '$1$2$3$4');

        if (!REPLAY_CODE_REGEX.test(code)) {
            throw new ResponseError(400, 'invalid_code', 'Invalid replay code');
        }

        debug('Lookup %s', code);

        const data = await this.lookupReplayCode(code);

        if (!data.replay) {
            throw new ResponseError(404, 'not_found', 'Replay not found');
        }

        const replay_id = Buffer.from(data.replay.id, 'base64').toString();
        const match = replay_id.match(/^Replay-(u-[a-z0-9]{20}):([A-Z0-9]{16})$/);
        if (!match) throw new ResponseError(500, 'unknown_error', 'Error decoding replay ID');
        const npln_user_id = match[1];

        const code_formatted = code.replace(/^([A-Z0-9]{4})([A-Z0-9]{4})([A-Z0-9]{4})([A-Z0-9]{4})$/, '$1-$2-$3-$4');
        const share_url = 'https://s.nintendo.com/av5ja-lp1/znca/game/4834290508791808?p=' +
            encodeURIComponent('/replay?code=' + encodeURIComponent(code_formatted));

        const base_url = process.env.BASE_URL ??
            (req.headers['x-forwarded-proto'] === 'https' ? 'https://' : 'http://') +
            req.headers.host;
        const resources_url = base_url + '/api/splatnet3/resources/';
        const images = await this.downloadImages(data.replay, resources_url);

        return {
            code,
            share_url,
            replay: data.replay,
            request_id: data.request_id,
            npln_user_id,
            [ResourceUrlMapSymbol]: images,
        };
    }

    lookupReplayCode(code: string) {
        const promise = this.promise.get(code) ?? Promise.resolve().then(async () => {
            const request_id = this.splatnet.api.getPersistedQueryId(RequestId.DownloadSearchReplayQuery);
            const key = 'Replay.' + request_id + '.' + code;
            const cache_replay: ReplayData | undefined = await this.cache.getItem(key);

            if (cache_replay) {
                debug('Using cached data for replay code %s', code);
                return cache_replay;
            }

            try {
                debug('Searching for replay code %s', code);
                const replay = await this.splatnet.api.getReplaySearchResult(code);

                const data: ReplayData = {
                    replay: replay.data.replay,
                    request_id: replay[RequestIdSymbol],
                    created_at: Date.now(),
                };

                await this.cache.setItem(key, data);

                return data;
            } catch (err) {
                if (err instanceof ErrorResponse && err.data.data.replay === null) {
                    const data: ReplayData = {
                        replay: null,
                        request_id,
                        created_at: Date.now(),
                    };

                    await this.cache.setItem(key, data);

                    return data;
                }

                throw err;
            }
        }).then(result => {
            this.promise.delete(code);
            return result;
        }).catch(err => {
            this.promise.delete(code);
            throw err;
        });

        this.promise.set(code, promise);

        return promise;
    }

    async downloadImages(data: unknown, base_url?: string): Promise<Record<string, string>> {
        const image_urls: string[] = [];

        // Use JSON.stringify to iterate over everything in the response
        JSON.stringify(data, (key: string, value: unknown) => {
            if (typeof value === 'object' && value && 'url' in value && typeof value.url === 'string') {
                if (value.url.toLowerCase().startsWith('https://api.lp1.av5ja.srv.nintendo.net/')) {
                    image_urls.push(value.url);
                }
            }

            return value;
        });

        const url_map: Record<string, string> = {};

        await Promise.all(image_urls.map(async url => {
            url_map[url] = new URL(await this.downloadImage(url), base_url).toString();
        }));

        return url_map;
    }

    downloadImage(url: string) {
        const name = new URL(url).pathname.substr(1).toLowerCase()
            .replace(/^resources\//g, '')
            .replace(/(\/|^)\.\.(\/|$)/g, '$1...$2');

        const promise = this.promise_image.get(name) ?? Promise.resolve().then(async () => {
            try {
                await fs.stat(new URL('../data/resources/' + name, import.meta.url));

                debug('Already downloaded image %s', name);
                return name;
            } catch (err) {}

            debug('Fetching image %s', name);
            const response = await fetch(url);
            const data = new Uint8Array(await response.arrayBuffer());

            if (!response.ok) throw new ErrorResponse('Unable to download resource ' + name, response, data.toString());

            await fs.mkdir(dirname(fileURLToPath(new URL('../data/resources/' + name, import.meta.url))), {recursive: true});
            await fs.writeFile(new URL('../data/resources/' + name, import.meta.url), data);

            debug('Downloaded image %s', name);

            return name;
        }).then(result => {
            this.promise_image.delete(name);
            return result;
        }).catch(err => {
            this.promise_image.delete(name);
            throw err;
        });

        this.promise_image.set(name, promise);

        return promise;
    }
}

export class ResponseError extends Error {
    constructor(readonly status: number, readonly code: string, message?: string) {
        super(message);
    }

    sendResponse(req: Request, res: Response) {
        const data = {
            error: this.code,
            error_message: this.message,
        };

        res.statusCode = this.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(req.headers['accept']?.match(/\/html\b/i) ?
            JSON.stringify(data, null, 4) : JSON.stringify(data));
    }
}

const storage = await Storage.create(LocalStorageProvider, new URL('../data', import.meta.url));
const users = new Users(storage, process.env.ZNC_PROXY_URL);
const splatnet = await users.get(SplatNet3, process.env.NA_USER_ID!);

const cache = persist.create({
    dir: fileURLToPath(new URL('../data/persist', import.meta.url)),
    stringify: data => JSON.stringify(data, null, 4) + '\n',
    expiredInterval: 0,
});
await cache.init();

const server = new Server(splatnet, cache);

server.app.listen(8080, () => {
    console.log('Listening on [::]:8080');
});
