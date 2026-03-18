#!/usr/bin/env node
/**
 * garmin-fetch.js — fetch wellness/activity data from Garmin Connect
 *
 * Usage:
 *   node garmin-fetch.js --type daily   --date YYYY-MM-DD
 *   node garmin-fetch.js --type weekly  --weekStart YYYY-MM-DD --weekEnd YYYY-MM-DD
 *
 * Config file:  ~/.garmin-obsidian.json  { "email": "...", "password": "..." }
 * Token cache:  ~/.garmin-tokens/        (auto-managed; delete dir to force re-login)
 */
'use strict';

const { GarminConnect } = require('garmin-connect');
const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'garmin.credentials.json');
const TOKEN_DIR   = path.join(__dirname, 'garmin-tokens');

const CYCLING_TYPES = new Set([
    'cycling', 'road_biking', 'mountain_biking', 'gravel_cycling',
    'virtual_ride', 'indoor_cycling', 'e_sport_cycling'
]);

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = (argv[i] || '').replace(/^--/, '');
        if (key) args[key] = argv[i + 1];
    }
    return args;
}

// API methods require Date objects; use noon local time to avoid timezone boundary issues
function toDate(dateStr) {
    return new Date(dateStr + 'T12:00:00');
}

async function getClient() {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        throw new Error('Cannot read ' + CONFIG_FILE + ' — run the Node-RED Setup inject node first.');
    }
    if (!config.email || !config.password) {
        throw new Error('Config file is missing email or password.');
    }

    const client = new GarminConnect({ username: config.email, password: config.password });

    const tokensExist = fs.existsSync(path.join(TOKEN_DIR, 'oauth1_token.json'))
                     && fs.existsSync(path.join(TOKEN_DIR, 'oauth2_token.json'));
    if (tokensExist) {
        try {
            client.loadTokenByFile(TOKEN_DIR);
        } catch (_) {
            await client.login();
            client.exportTokenToFile(TOKEN_DIR);
        }
    } else {
        await client.login();
        client.exportTokenToFile(TOKEN_DIR);
    }

    return client;
}

async function fetchDaily(client, date) {
    const weightUrl = 'https://connectapi.garmin.com/weight-service/weight/dayview/' + date;

    const [sleepResult, stepsResult, hrResult, weightResult] = await Promise.allSettled([
        client.getSleepData(toDate(date)),
        client.getSteps(toDate(date)),
        client.getHeartRate(toDate(date)),
        client.get(weightUrl)
    ]);

    // Sleep
    const sleepRaw = sleepResult.status === 'fulfilled' ? sleepResult.value : null;
    const dto = (sleepRaw && sleepRaw.dailySleepDTO) || {};
    const sleep = {
        durationSeconds:   dto.sleepTimeSeconds    || null,
        deepSleepSeconds:  dto.deepSleepSeconds     || null,
        lightSleepSeconds: dto.lightSleepSeconds    || null,
        remSleepSeconds:   dto.remSleepSeconds      || null,
        awakeSleepSeconds: dto.awakeSleepSeconds    || null,
        sleepScore:        dto.sleepScorePersonalized || dto.sleepScore || null
    };

    // Heart rate — use dedicated endpoint (not sleep DTO, which returns null)
    const hrRaw = hrResult.status === 'fulfilled' ? hrResult.value : null;
    const hr = {
        restingHR: (hrRaw && hrRaw.restingHeartRate) || null,
        maxHR:     (hrRaw && hrRaw.maxHeartRate)     || null
    };

    // Steps
    const stepsRaw = stepsResult.status === 'fulfilled' ? stepsResult.value : null;
    const totalSteps = typeof stepsRaw === 'number' ? stepsRaw :
                       (stepsRaw && typeof stepsRaw.steps === 'number') ? stepsRaw.steps : null;

    // Weight — only present if logged on this exact date
    const weightRaw = weightResult.status === 'fulfilled' ? weightResult.value : null;
    const weightEntry = (weightRaw && weightRaw.dateWeightList && weightRaw.dateWeightList[0]) || null;
    const weight = weightEntry ? { kg: weightEntry.weight / 1000 } : null;

    return {
        type: 'daily',
        date,
        sleep,
        hr,
        wellness: { totalSteps },
        weight
    };
}

async function fetchWeekly(client, weekStart, weekEnd) {
    const activities = await client.getActivities(0, 100);
    const startMs = new Date(weekStart).getTime();
    const endMs   = new Date(weekEnd).getTime() + 86400000 - 1;  // end of weekEnd day

    const rides = (Array.isArray(activities) ? activities : []).filter(a => {
        const typeKey = ((a.activityType && a.activityType.typeKey) || '').toLowerCase();
        if (!CYCLING_TYPES.has(typeKey)) return false;
        const ts = a.beginTimestamp || (a.startTimeInSeconds && a.startTimeInSeconds * 1000);
        return ts && ts >= startMs && ts <= endMs;
    });

    const stats = rides.reduce((acc, r) => ({
        distanceM:  acc.distanceM  + (r.distance      || 0),
        elevationM: acc.elevationM + (r.elevationGain  || 0),
        movingSecs: acc.movingSecs + (r.movingDuration || r.duration || 0),
        count:      acc.count + 1
    }), { distanceM: 0, elevationM: 0, movingSecs: 0, count: 0 });

    return { type: 'weekly', weekStart, weekEnd, stats };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (!args.type) {
        process.stderr.write('Usage: garmin-fetch.js --type daily|weekly ...\n');
        process.exit(1);
    }

    const client = await getClient();
    let result;

    if (args.type === 'daily') {
        if (!args.date) { process.stderr.write('--date YYYY-MM-DD required\n'); process.exit(1); }
        result = await fetchDaily(client, args.date);

    } else if (args.type === 'weekly') {
        if (!args.weekStart || !args.weekEnd) {
            process.stderr.write('--weekStart and --weekEnd required\n');
            process.exit(1);
        }
        result = await fetchWeekly(client, args.weekStart, args.weekEnd);

    } else {
        process.stderr.write('Unknown --type: ' + args.type + '\n');
        process.exit(1);
    }

    process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch(e => {
    process.stderr.write((e.message || String(e)) + '\n');
    process.exit(1);
});
