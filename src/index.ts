import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Storage, LocalStorageProvider, Users, ErrorResponse, version, addUserAgent } from 'nxapi';
import { SplatNet3 } from 'nxapi/splatnet3';
import { DownloadSearchReplayResult, RequestId } from 'splatnet3-types/splatnet3';
import express from 'express';
import persist from 'node-persist';

interface ReplayData {
    replay: DownloadSearchReplayResult['replay'] | null;
    request_id: string;
    created_at: number;
}

const product = 'splatoon3-replay-lookup/0.1.0';
addUserAgent(product);

const storage = await Storage.create(LocalStorageProvider, new URL('../data', import.meta.url));
const users = new Users(storage, process.env.ZNC_PROXY_URL);
const splatnet = await users.get(SplatNet3, process.env.NA_USER_ID!);

const app = express();

const cache = persist.create({
    dir: fileURLToPath(new URL('../data/persist', import.meta.url)),
    stringify: data => JSON.stringify(data, null, 4) + '\n',
});
await cache.init();

const replays = new Map<string, Promise<ReplayData>>();

const REPLAY_CODE_REGEX = /^[A-Z0-9]{16}$/;

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

app.get('/api/splatnet3/replay/:code', async (req, res) => {
    try {
        const code = req.params.code.replace(/^([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})-([A-Z0-9]{4})$/, '$1$2$3$4');

        if (!REPLAY_CODE_REGEX.test(code)) {
            throw new Error('Invalid replay code');
        }

        console.warn('Lookup %s', code);

        const promise = replays.get(code) ?? Promise.resolve().then(async () => {
            const request_id = splatnet.api.getPersistedQueryId(RequestId.DownloadSearchReplayQuery);
            const key = 'Replay.' + request_id + '.' + code;
            const cache_replay: ReplayData | undefined = await cache.getItem(key);

            if (cache_replay) return cache_replay;

            try {
                const replay = await splatnet.api.getReplaySearchResult(code);

                const data: ReplayData = {
                    replay: replay.data.replay,
                    request_id,
                    created_at: Date.now(),
                };

                await cache.setItem(key, data);

                return data;
            } catch (err) {
                if (err instanceof ErrorResponse && err.data.data.replay === null) {
                    const data: ReplayData = {
                        replay: null,
                        request_id,
                        created_at: Date.now(),
                    };

                    await cache.setItem(key, data);

                    return data;
                }

                throw err;
            }
        }).finally(() => {
            replays.delete(code);
        });

        replays.set(code, promise);

        const data = await promise;

        if (!data.replay) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: 'not_found',
                error_message: 'Replay not found',
            }, null, 4) + '\n');
            return;
        }

        const replay_id = Buffer.from(data.replay.id, 'base64').toString();
        const match = replay_id.match(/^Replay-(u-[a-z0-9]{20}):([A-Z0-9]{16})$/);
        if (!match) throw new Error('Error decoding replay ID');
        const npln_user_id = match[1];

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            replay: data.replay,
            request_id: data.request_id,
            npln_user_id,
        }, null, 4) + '\n');
    } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            error: err,
            error_message: (err as Error).message,
        }, null, 4) + '\n');
    }
});

app.listen(8080, () => {
    console.log('Listening on [::]:8080');
});
