// scripts/update-fans.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = {
    defaultUid: '3690985523514020',
    defaultPageSize: 30,
    creators: [
        {
            uid: '3690985523514020',
            name: 'Kansatsu',
            outputPrefix: 'kansatsu'
        },
        {
            uid: '689955798',
            name: 'Dolphin',
            outputPrefix: 'dolphin'
        },
        {
            uid: '491378910',
            name: 'Yumee',
            outputPrefix: 'yumee'
        }
    ],
    outputDir: 'data',
    textOutputTemplate: '{prefix}-fans.txt',
    jsonOutputTemplate: '{prefix}-fans.json',
    combinedOutput: 'fans.json',
    requestDelay: 800,
    userAgent: 'aivup.live fan-list updater'
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function normalizeUid(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (/^\d+$/.test(raw)) return raw;
    if (/^\d+(?:\.\d+)?e[+-]?\d+$/i.test(raw)) {
        const numeric = Number(raw);
        if (Number.isSafeInteger(numeric) && numeric > 0) return numeric.toFixed(0);
    }
    return raw;
}

async function fetchJson(url, userAgent) {
    const response = await fetch(url, { headers: { 'user-agent': userAgent } });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Request failed (${response.status}) for ${url}: ${body.slice(0, 200)}`);
    }
    const payload = await response.json();
    if (payload?.code !== 0) {
        throw new Error(`API returned code ${payload?.code} for ${url}: ${payload?.message ?? payload?.msg ?? 'Unknown error'}`);
    }
    return payload.data;
}

async function readFileIfExists(filePath) {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function sanitizeName(name) {
    return String(name ?? '').replace(/\r?\n|\r/g, ' ').trim();
}

function compareFans(a, b) {
    if (b.isCaptain !== a.isCaptain) return Number(b.isCaptain) - Number(a.isCaptain);
    if (b.level !== a.level) return b.level - a.level;
    if (b.guardLevel !== a.guardLevel) return b.guardLevel - a.guardLevel;
    return String(a.uid).localeCompare(String(b.uid), 'en');
}

function quoteCsvField(value) {
    const text = String(value ?? '');
    if (!/[",\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const next = line[index + 1];
        if (char === '"') {
            if (inQuotes && next === '"') { current += '"'; index += 1; }
            else { inQuotes = !inQuotes; }
            continue;
        }
        if (char === ',' && !inQuotes) { fields.push(current); current = ''; continue; }
        current += char;
    }
    fields.push(current);
    return fields;
}

function normalizeStoredFan(item) {
    return {
        uid: String(item?.uid ?? '').trim(),
        name: sanitizeName(item?.name),
        level: Number.parseInt(item?.level ?? 0, 10) || 0,
        isCaptain: item?.isCaptain === true || (Number.parseInt(item?.isCaptain ?? 0, 10) || 0) > 0,
        guardLevel: Number.parseInt(item?.guardLevel ?? item?.isCaptain ?? 0, 10) || 0
    };
}

function parseLegacyFansText(text) {
    const fans = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const fields = parseCsvLine(line);
        if (fields.length < 3) continue;
        fans.push(normalizeStoredFan({ uid: fields[0], name: fields[1], level: fields[2], isCaptain: fields[3] ?? 0 }));
    }
    return fans;
}

function upsertFan(map, fan) {
    if (!fan.uid || !fan.name) return;
    const key = String(fan.uid);
    const existing = map.get(key);
    if (!existing) {
        map.set(key, {
            uid: key, name: fan.name, level: fan.level,
            isCaptain: fan.isCaptain, guardLevel: fan.guardLevel,
            firstSeenAt: new Date().toISOString()
        });
        return;
    }
    existing.name = fan.name || existing.name;
    existing.level = Math.max(existing.level, fan.level);
    existing.isCaptain = existing.isCaptain || fan.isCaptain;
    existing.guardLevel = Math.max(existing.guardLevel, fan.guardLevel);
    existing.lastSeenAt = new Date().toISOString();
}

function normalizeFanMember(item) {
    return {
        uid: String(item?.uid ?? '').trim(),
        name: sanitizeName(item?.name),
        level: Number.parseInt(item?.level ?? item?.uinfo_medal?.level ?? 0, 10) || 0,
        isCaptain: (Number.parseInt(item?.guard_level ?? item?.uinfo_medal?.guard_level ?? 0, 10) || 0) > 0,
        guardLevel: Number.parseInt(item?.guard_level ?? item?.uinfo_medal?.guard_level ?? 0, 10) || 0
    };
}

function normalizeGuardMember(item) {
    return {
        uid: String(item?.uinfo?.uid ?? item?.uid ?? '').trim(),
        name: sanitizeName(item?.uinfo?.base?.name ?? item?.name),
        level: Number.parseInt(item?.uinfo?.medal?.level ?? item?.level ?? 0, 10) || 0,
        isCaptain: (Number.parseInt(item?.uinfo?.guard?.level ?? item?.uinfo?.medal?.guard_level ?? 0, 10) || 0) > 0,
        guardLevel: Number.parseInt(item?.uinfo?.guard?.level ?? item?.uinfo?.medal?.guard_level ?? 0, 10) || 0
    };
}

async function getRoomId(anchorUid, userAgent) {
    const data = await fetchJson(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${anchorUid}`, userAgent);
    const roomId = data?.room_id;
    if (!roomId) throw new Error(`Unable to resolve room_id for uid ${anchorUid}`);
    return roomId;
}

async function fetchAllFanMembers(anchorUid, pageSize, userAgent) {
    const members = [];
    for (let page = 1; ; page += 1) {
        const data = await fetchJson(
            `https://api.live.bilibili.com/xlive/general-interface/v1/rank/getFansMembersRank?ruid=${anchorUid}&page_size=${pageSize}&page=${page}`,
            userAgent
        );
        const items = Array.isArray(data?.item) ? data.item : [];
        members.push(...items);
        const total = Number.parseInt(data?.num ?? 0, 10) || members.length;
        if (!items.length || members.length >= total) break;
        if (CONFIG.requestDelay > 0) await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
    }
    return members;
}

async function fetchAllGuards(anchorUid, roomId, pageSize, userAgent) {
    const guards = [];
    const seen = new Set();
    for (let page = 1; ; page += 1) {
        const data = await fetchJson(
            `https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topListNew?ruid=${anchorUid}&roomid=${roomId}&page=${page}&page_size=${pageSize}`,
            userAgent
        );
        const batch = [];
        if (page === 1 && Array.isArray(data?.top3)) batch.push(...data.top3);
        if (Array.isArray(data?.list)) batch.push(...data.list);
        for (const item of batch) {
            const member = normalizeGuardMember(item);
            if (!member.uid || seen.has(member.uid)) continue;
            seen.add(member.uid);
            guards.push(member);
        }
        const total = Number.parseInt(data?.info?.num ?? 0, 10) || guards.length;
        if (!batch.length || guards.length >= total) break;
        if (CONFIG.requestDelay > 0) await new Promise(resolve => setTimeout(resolve, CONFIG.requestDelay));
    }
    return guards;
}

async function loadExistingFans(jsonPath, textPath) {
    const mergedFans = new Map();
    const existingJson = await readFileIfExists(jsonPath);
    if (existingJson) {
        const payload = JSON.parse(existingJson);
        const fans = Array.isArray(payload) ? payload : payload?.fans;
        if (Array.isArray(fans)) {
            for (const item of fans) upsertFan(mergedFans, normalizeStoredFan(item));
        }
    }
    const existingText = await readFileIfExists(textPath);
    if (existingText) {
        for (const item of parseLegacyFansText(existingText)) upsertFan(mergedFans, item);
    }
    return { fans: Array.from(mergedFans.values()).sort(compareFans) };
}

async function processCreator(creator) {
    const { uid, name, outputPrefix } = creator;
    const pageSize = CONFIG.defaultPageSize;
    const userAgent = CONFIG.userAgent;
    
    console.log(`[${new Date().toISOString()}] Processing: ${name} (UID: ${uid})`);

    const outputDir = path.resolve(repoRoot, CONFIG.outputDir);
    await fs.mkdir(outputDir, { recursive: true });
    
    const textOutputPath = path.resolve(outputDir, CONFIG.textOutputTemplate.replace('{prefix}', outputPrefix));
    const jsonOutputPath = path.resolve(outputDir, CONFIG.jsonOutputTemplate.replace('{prefix}', outputPrefix));

    const existingData = await loadExistingFans(jsonOutputPath, textOutputPath);
    const roomId = await getRoomId(uid, userAgent);
    const fanMembers = await fetchAllFanMembers(uid, pageSize, userAgent);
    const guardMembers = await fetchAllGuards(uid, roomId, pageSize, userAgent);

    const mergedFans = new Map();
    for (const item of existingData.fans) upsertFan(mergedFans, item);
    for (const item of fanMembers) upsertFan(mergedFans, normalizeFanMember(item));
    for (const item of guardMembers) upsertFan(mergedFans, item);

    const fans = Array.from(mergedFans.values()).sort(compareFans);

    const textOutput = fans.map((fan) => 
        [fan.uid, fan.name, fan.level, fan.isCaptain ? 1 : 0].map(quoteCsvField).join(',')
    ).join('\n').concat('\n');

    const jsonOutput = {
        uid, creatorName: name, roomId,
        generatedAt: new Date().toISOString(),
        stats: {
            total: fans.length,
            captains: fans.filter(f => f.isCaptain).length,
            fansOnly: fans.filter(f => !f.isCaptain).length
        },
        fans: fans.map(f => ({
            uid: f.uid, name: f.name, level: f.level,
            isCaptain: f.isCaptain, guardLevel: f.guardLevel
        }))
    };

    await fs.writeFile(textOutputPath, textOutput, 'utf8');
    await fs.writeFile(jsonOutputPath, JSON.stringify(jsonOutput, null, 2) + '\n', 'utf8');

    console.log(`✓ Updated ${fans.length} records for ${name}`);
    console.log(`  Captains: ${jsonOutput.stats.captains}, Fans: ${jsonOutput.stats.fansOnly}`);
    
    return { uid, name, stats: jsonOutput.stats, fans: jsonOutput.fans };
}

async function generateCombinedJson(results) {
    const combinedPath = path.resolve(repoRoot, CONFIG.combinedOutput);
    
    const combined = {
        generatedAt: new Date().toISOString(),
        creators: {},
        totalStats: { totalFans: 0, totalCaptains: 0 }
    };
    
    for (const result of results) {
        if (result) {
            combined.creators[result.uid] = {
                name: result.name,
                stats: result.stats,
                fans: result.fans
            };
            combined.totalStats.totalFans += result.stats.total;
            combined.totalStats.totalCaptains += result.stats.captains;
        }
    }
    
    await fs.writeFile(combinedPath, JSON.stringify(combined, null, 2) + '\n', 'utf8');
    console.log(`✓ Generated combined file: ${CONFIG.combinedOutput}`);
    console.log(`  Total: ${combined.totalStats.totalFans} fans, ${combined.totalStats.totalCaptains} captains`);
}

async function main() {
    console.log('aivup Fan List Updater');
    console.log('='.repeat(50));
    
    const results = [];
    for (const creator of CONFIG.creators) {
        try {
            const result = await processCreator(creator);
            results.push(result);
        } catch (error) {
            console.error(`✗ Failed to process ${creator.name}:`, error.message);
        }
    }
    
    await generateCombinedJson(results);
    
    console.log('='.repeat(50));
    console.log('Update completed.');
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
});