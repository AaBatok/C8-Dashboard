/**
 * CANTOR8 Web Dashboard
 * - Express web server with real-time SSE streaming
 * - Check reward & balance for all accounts via browser
 * - No Telegram dependency
 *
 * Run:   node report.js
 * Access: http://YOUR_IP:3000
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'dotenv/config';
import express from 'express';

// ── Setup ────────────────────────────────────────────────────────────────
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

const BACKEND = config.api.backend_url;
const SWAP_API = config.api.swap_url;

const BASE_HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Origin': 'https://wallet.cantor8.tech',
    'Referer': 'https://wallet.cantor8.tech/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
};

const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';

// ── Utils ────────────────────────────────────────────────────────────────

const sleep = (sec) => new Promise(r => setTimeout(r, sec * 1000));

function fmtNum(v, decimals = 2) {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return '0';
    return n.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
    });
}

function ts() {
    return new Date().toLocaleTimeString('en-GB', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).replace(/:/g, '.');
}

// ── Retry Helpers ────────────────────────────────────────────────────────

const RETRYABLE_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE',
    'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ECONNABORTED'
];

function isRetryableError(err) {
    if (RETRYABLE_CODES.includes(err.code)) return true;
    if (err.response?.status >= 500) return true;
    if (err.response?.status === 429) return true;
    if (err.message?.includes('socket hang up')) return true;
    if (err.message?.includes('ECONNRESET')) return true;
    if (err.message?.includes('network')) return true;
    if (err.message?.includes('timeout')) return true;
    if (err.code === 'ERR_BAD_RESPONSE') return true;
    return false;
}

function formatError(err) {
    if (err.response) {
        const code = err.response.status;
        if (code === 400) {
            const detail = String(err.response.data?.detail || err.response.data?.message || JSON.stringify(err.response.data) || '');
            return `[400] ${detail.slice(0, 150)}`;
        }
        if (code === 401) return '[401] Unauthorized';
        if (code === 404) return '[404] Not found';
        if (code === 429) return '[429] Rate limited';
        return `[${code}] ${err.response.statusText || 'HTTP error'}`;
    }
    if (err.code) return `[${err.code}] ${err.message}`;
    return String(err.message || err);
}

async function retryOnNetwork(fn, { maxRetries = 5, baseDelay = 3, label = '' } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isRetryableError(err) || attempt >= maxRetries) throw err;
            const delay = Math.min(baseDelay * Math.pow(2, attempt), 60);
            console.log(`${ts()} 🔄 [${label || 'retry'}] ${formatError(err)} (attempt ${attempt + 1}/${maxRetries}, wait ${delay}s)`);
            await sleep(delay);
        }
    }
}

// ── Load Accounts ────────────────────────────────────────────────────────
// Priority: accounts.txt (1 phrase per line) → .env (ACCOUNT_X_MNEMONIC)

function loadAccounts() {
    const txtPath = join(__dirname, 'accounts.txt');

    // ── Try accounts.txt first (simple: 1 phrase per line) ──
    if (existsSync(txtPath)) {
        const lines = readFileSync(txtPath, 'utf-8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        if (lines.length > 0) {
            console.log(`${ts()} 📂 Loaded ${lines.length} accounts from accounts.txt`);
            return lines.map((mnemonic, i) => ({
                index: i + 1,
                name: 'A' + (i + 1),
                mnemonic,
                proxy: null,
            }));
        }
    }

    // ── Fallback: .env format ──
    const keys = Object.keys(process.env);
    let maxId = 0;
    for (const key of keys) {
        const match = key.match(/^ACCOUNT_(\d+)_MNEMONIC$/);
        if (match) maxId = Math.max(maxId, parseInt(match[1], 10));
    }

    const accounts = [];
    for (let i = 1; i <= maxId; i++) {
        const mnemonic = process.env[`ACCOUNT_${i}_MNEMONIC`];
        if (!mnemonic) continue;
        accounts.push({
            index: i,
            name: process.env[`ACCOUNT_${i}_NAME`] || 'A' + i,
            mnemonic: mnemonic.trim(),
            proxy: process.env[`ACCOUNT_${i}_PROXY`] || null,
        });
    }

    if (accounts.length > 0) {
        console.log(`${ts()} 📂 Loaded ${accounts.length} accounts from .env`);
    }
    return accounts;
}

// ── Axios / API ──────────────────────────────────────────────────────────

function createAxiosInstance(proxyUrl) {
    const opts = { timeout: 30000 };
    if (proxyUrl) {
        const agent = new HttpsProxyAgent(proxyUrl);
        opts.httpAgent = agent;
        opts.httpsAgent = agent;
        opts.proxy = false;
    }
    return axios.create(opts);
}

function createWalletApi(ax) {
    const h = BASE_HEADERS;
    return {
        recoverAccount: (keys) =>
            ax.post(`${BACKEND}/accounts/recovery_v3`, { public_keys: keys }, { headers: h }).then(r => r.data),
        getBalance: (token) =>
            ax.get(`${BACKEND}/balance`, { headers: { ...h, Authorization: `Bearer ${token}` } }).then(r => r.data),
        getChallenge: (pid) =>
            ax.post(`${BACKEND}/auth/challenge`, { party_id: pid }, { headers: h }).then(r => r.data),
        login: (pid, ch, sig) =>
            ax.post(`${BACKEND}/auth/login`, { party_id: pid, challenge: ch, signature: sig }, { headers: h }).then(r => r.data),
    };
}

function createSwapApi(ax) {
    const h = BASE_HEADERS;
    return {
        getLeaderboard: (address = null) =>
            ax.get(`${SWAP_API}/leaderboard`, {
                params: {
                    limit: 50,
                    includeRewards: true,
                    includeAll: true,
                    ...(address ? { address } : {}),
                },
                headers: h,
            }).then(r => r.data),
    };
}

// ── Crypto ───────────────────────────────────────────────────────────────

function generateKeyPairs(mnemonic) {
    const { path_prefix, path_suffix, key_count } = config.derivation;
    const seed = mnemonicToSeedSync(mnemonic, '');
    const hdkey = HDKey.fromMasterSeed(seed);
    const keyPairs = [];

    for (let i = 0; i < key_count; i++) {
        const path = `${path_prefix}/${i}'/${path_suffix}`;
        const child = hdkey.derive(path);
        const privateKey = child.privateKey;
        if (!privateKey || privateKey.length !== 32) {
            throw new Error(`Key derivation failed at ${path}`);
        }
        const publicKey = ed.getPublicKey(privateKey);
        keyPairs.push({
            index: i,
            path,
            privateKey,
            publicKey,
            publicKeyHex: Buffer.from(publicKey).toString('hex'),
        });
    }

    return keyPairs;
}

function signMessage(privateKey, message) {
    const msg = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    return ed.sign(msg, privateKey);
}

function toHex(bytes) {
    return Buffer.from(bytes).toString('hex');
}

// ── Fetchers ─────────────────────────────────────────────────────────────

async function fetchWalletReward(account) {
    const ax = createAxiosInstance(account.proxy || '');
    const walletApi = createWalletApi(ax);
    const swapApi = createSwapApi(ax);

    const keyPairs = generateKeyPairs(account.mnemonic);

    const recovery = await retryOnNetwork(
        () => walletApi.recoverAccount(keyPairs.map(k => k.publicKeyHex)),
        { maxRetries: 5, baseDelay: 3, label: `${account.name}:recover` }
    );

    const matchIdx = (recovery.results || []).findIndex(r => r !== null);
    if (matchIdx === -1) throw new Error('No account found for this mnemonic');

    const acct = recovery.results[matchIdx];
    const partyId = acct.party_id;

    const lb = await retryOnNetwork(
        () => swapApi.getLeaderboard(partyId),
        { maxRetries: 5, baseDelay: 3, label: `${account.name}:leaderboard` }
    );

    const me = lb?.requestedAddress || null;

    return {
        name: account.name,
        partyId,
        rank: Number(me?.rank ?? me?.position ?? 0),
        reward: Number(me?.rewardAccruedCc ?? 0),
        totalReward: Number(me?.rewardTotalCc ?? 0),
        volume: Number(me?.rewardVolumeUsd ?? me?.volumeUsd ?? 0),
        txns: Number(me?.rewardSwapCount ?? me?.swapCount ?? 0),
    };
}

async function fetchWalletBalance(account) {
    const ax = createAxiosInstance(account.proxy || '');
    const walletApi = createWalletApi(ax);

    const keyPairs = generateKeyPairs(account.mnemonic);

    const recovery = await retryOnNetwork(
        () => walletApi.recoverAccount(keyPairs.map(k => k.publicKeyHex)),
        { maxRetries: 5, baseDelay: 3, label: `${account.name}:recover` }
    );

    const matchIdx = (recovery.results || []).findIndex(r => r !== null);
    if (matchIdx === -1) throw new Error('No account found for this mnemonic');

    const acct = recovery.results[matchIdx];
    const partyId = acct.party_id;
    const keyPair = keyPairs[matchIdx];

    const authData = await retryOnNetwork(async () => {
        const { challenge } = await walletApi.getChallenge(partyId);
        const sig = toHex(signMessage(keyPair.privateKey, challenge));
        return await walletApi.login(partyId, challenge, sig);
    }, { maxRetries: 5, baseDelay: 3, label: `${account.name}:login` });

    const balance = await retryOnNetwork(
        () => walletApi.getBalance(authData.access_token),
        { maxRetries: 5, baseDelay: 3, label: `${account.name}:balance` }
    );

    const holdings = balance?.holdings || {};
    const cc =
        Number(holdings?.['Amulet']?.balance || 0) ||
        Number(holdings?.['CC (Amulet)']?.balance || 0) ||
        Number(holdings?.['CC']?.balance || 0);

    const usdcx =
        Number(holdings?.['USDCx']?.balance || 0) ||
        Number(holdings?.['USDCX']?.balance || 0);

    const ceth =
        Number(holdings?.['cETH']?.balance || 0) ||
        Number(holdings?.['CETH']?.balance || 0) ||
        Number(holdings?.['Ceth']?.balance || 0);

    return {
        name: account.name,
        partyId,
        cc: Number(cc || 0),
        usdcx: Number(usdcx || 0),
        ceth: Number(ceth || 0),
    };
}

// ── Stream State ─────────────────────────────────────────────────────────

const rewardState = { running: false, cache: null, clients: [], results: [], totalAccounts: 0 };
const balanceState = { running: false, cache: null, clients: [], results: [], totalAccounts: 0 };

function broadcast(state, data) {
    const msg = 'data: ' + JSON.stringify(data) + '\n\n';
    state.clients = state.clients.filter(client => {
        try { client.write(msg); return true; }
        catch (e) { return false; }
    });
}

function addClient(state, req, res) {
    state.clients.push(res);
    req.on('close', () => {
        state.clients = state.clients.filter(c => c !== res);
    });
}

function sseHeaders(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
}

// ── Express Server ───────────────────────────────────────────────────────

const app = express();
app.use(express.static(join(__dirname, 'public')));

// ── Reward SSE Stream ────────────────────────────────────────────────────

app.get('/api/reward/stream', async (req, res) => {
    sseHeaders(res);

    // If already running, subscribe to existing stream
    if (rewardState.running) {
        res.write('data: ' + JSON.stringify({ type: 'start', total: rewardState.totalAccounts }) + '\n\n');
        for (const r of rewardState.results) {
            res.write('data: ' + JSON.stringify({ type: 'result', data: r }) + '\n\n');
        }
        res.write('data: ' + JSON.stringify({
            type: 'progress',
            current: rewardState.results.length,
            total: rewardState.totalAccounts,
            name: '(joining stream...)'
        }) + '\n\n');
        addClient(rewardState, req, res);
        return;
    }

    const accounts = loadAccounts();
    if (accounts.length === 0) {
        res.write('data: ' + JSON.stringify({ type: 'error', message: 'No accounts found in .env' }) + '\n\n');
        res.end();
        return;
    }

    rewardState.running = true;
    rewardState.results = [];
    rewardState.totalAccounts = accounts.length;
    addClient(rewardState, req, res);

    broadcast(rewardState, { type: 'start', total: accounts.length });
    console.log(`${ts()} 📡 [WEB] Fetching reward for ${accounts.length} account(s)...`);

    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        broadcast(rewardState, { type: 'progress', current: i + 1, total: accounts.length, name: acc.name });

        try {
            console.log(`${ts()} → ${acc.name}`);
            const result = await fetchWalletReward(acc);
            rewardState.results.push(result);
            broadcast(rewardState, { type: 'result', data: result });
            console.log(`${ts()}    OK reward=${fmtNum(result.reward, 4)} CC`);
        } catch (err) {
            const errResult = { name: acc.name, error: formatError(err) };
            rewardState.results.push(errResult);
            broadcast(rewardState, { type: 'result', data: errResult });
            console.log(`${ts()}    ERR ${formatError(err)}`);
        }

        await sleep(0.3);
    }

    rewardState.cache = { results: [...rewardState.results], timestamp: Date.now() };
    broadcast(rewardState, { type: 'done', timestamp: Date.now() });

    for (const client of rewardState.clients) {
        try { client.end(); } catch (e) { /* ignore */ }
    }
    rewardState.clients = [];
    rewardState.running = false;

    console.log(`${ts()} ✅ [WEB] Reward complete (${rewardState.cache.results.length} accounts)`);
});

// ── Balance SSE Stream ───────────────────────────────────────────────────

app.get('/api/balance/stream', async (req, res) => {
    sseHeaders(res);

    if (balanceState.running) {
        res.write('data: ' + JSON.stringify({ type: 'start', total: balanceState.totalAccounts }) + '\n\n');
        for (const r of balanceState.results) {
            res.write('data: ' + JSON.stringify({ type: 'result', data: r }) + '\n\n');
        }
        res.write('data: ' + JSON.stringify({
            type: 'progress',
            current: balanceState.results.length,
            total: balanceState.totalAccounts,
            name: '(joining stream...)'
        }) + '\n\n');
        addClient(balanceState, req, res);
        return;
    }

    const accounts = loadAccounts();
    if (accounts.length === 0) {
        res.write('data: ' + JSON.stringify({ type: 'error', message: 'No accounts found in .env' }) + '\n\n');
        res.end();
        return;
    }

    balanceState.running = true;
    balanceState.results = [];
    balanceState.totalAccounts = accounts.length;
    addClient(balanceState, req, res);

    broadcast(balanceState, { type: 'start', total: accounts.length });
    console.log(`${ts()} 📡 [WEB] Fetching balance for ${accounts.length} account(s)...`);

    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        broadcast(balanceState, { type: 'progress', current: i + 1, total: accounts.length, name: acc.name });

        try {
            console.log(`${ts()} → ${acc.name}`);
            const result = await fetchWalletBalance(acc);
            balanceState.results.push(result);
            broadcast(balanceState, { type: 'result', data: result });
            console.log(`${ts()}    OK cc=${fmtNum(result.cc, 2)} usdcx=${fmtNum(result.usdcx, 4)} ceth=${fmtNum(result.ceth, 6)}`);
        } catch (err) {
            const errResult = { name: acc.name, error: formatError(err) };
            balanceState.results.push(errResult);
            broadcast(balanceState, { type: 'result', data: errResult });
            console.log(`${ts()}    ERR ${formatError(err)}`);
        }

        await sleep(0.3);
    }

    balanceState.cache = { results: [...balanceState.results], timestamp: Date.now() };
    broadcast(balanceState, { type: 'done', timestamp: Date.now() });

    for (const client of balanceState.clients) {
        try { client.end(); } catch (e) { /* ignore */ }
    }
    balanceState.clients = [];
    balanceState.running = false;

    console.log(`${ts()} ✅ [WEB] Balance complete (${balanceState.cache.results.length} accounts)`);
});

// ── Status & Cache Endpoints ─────────────────────────────────────────────

app.get('/api/status', (req, res) => {
    res.json({
        reward: {
            running: rewardState.running,
            cached: rewardState.cache
                ? { timestamp: rewardState.cache.timestamp, count: rewardState.cache.results.length }
                : null,
        },
        balance: {
            running: balanceState.running,
            cached: balanceState.cache
                ? { timestamp: balanceState.cache.timestamp, count: balanceState.cache.results.length }
                : null,
        },
    });
});

app.get('/api/reward/cache', (req, res) => {
    if (rewardState.cache) res.json(rewardState.cache);
    else res.status(404).json({ error: 'No cached data' });
});

app.get('/api/balance/cache', (req, res) => {
    if (balanceState.cache) res.json(balanceState.cache);
    else res.status(404).json({ error: 'No cached data' });
});

// ── Start Server ─────────────────────────────────────────────────────────

app.listen(WEB_PORT, WEB_HOST, () => {
    const accounts = loadAccounts();
    console.log('');
    console.log('⚡ C8 Dashboard');
    console.log(`   URL:      http://${WEB_HOST}:${WEB_PORT}`);
    console.log(`   Accounts: ${accounts.length} loaded from .env`);
    console.log('');
});
