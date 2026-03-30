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

// Redirect console.log to stderr so library noise doesn't pollute JSON stdout
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');

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
    // Get display name for usersummary endpoint (steps, intensity, stress all in one call)
    const profile = await client.getUserProfile();
    const displayName = profile.displayName;

    const summaryUrl = 'https://connectapi.garmin.com/usersummary-service/usersummary/daily/'
                     + displayName + '?calendarDate=' + date;
    const weightUrl  = 'https://connectapi.garmin.com/weight-service/weight/dateRange'
                     + '?startDate=' + date + '&endDate=' + date;

    const [sleepResult, hrResult, weightResult, summaryResult] = await Promise.allSettled([
        client.getSleepData(toDate(date)),
        client.getHeartRate(toDate(date)),
        client.get(weightUrl),
        client.get(summaryUrl)
    ]);

    // Sleep — score lives in sleepScores.overall.value
    const sleepRaw = sleepResult.status === 'fulfilled' ? sleepResult.value : null;
    const dto = (sleepRaw && sleepRaw.dailySleepDTO) || {};
    const sleep = {
        durationSeconds:   dto.sleepTimeSeconds   || null,
        deepSleepSeconds:  dto.deepSleepSeconds    || null,
        lightSleepSeconds: dto.lightSleepSeconds   || null,
        remSleepSeconds:   dto.remSleepSeconds     || null,
        awakeSleepSeconds: dto.awakeSleepSeconds   || null,
        sleepScore:        (dto.sleepScores && dto.sleepScores.overall && dto.sleepScores.overall.value) || null,
        bodyBatteryChange: (sleepRaw && sleepRaw.bodyBatteryChange) || null
    };

    // Heart rate
    const hrRaw = hrResult.status === 'fulfilled' ? hrResult.value : null;
    const hr = {
        restingHR: (hrRaw && hrRaw.restingHeartRate) || null,
        maxHR:     (hrRaw && hrRaw.maxHeartRate)     || null
    };

    // User summary — steps, intensity minutes, stress (all in one call)
    const summaryRaw = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
    const wellness = {
        totalSteps:               (summaryRaw && summaryRaw.totalSteps)               || null,
        moderateIntensityMinutes: (summaryRaw && summaryRaw.moderateIntensityMinutes) || null,
        vigorousIntensityMinutes: (summaryRaw && summaryRaw.vigorousIntensityMinutes) || null,
        averageStressLevel:       (summaryRaw && summaryRaw.averageStressLevel > 0) ? summaryRaw.averageStressLevel : null,
    };

    // Weight — only present if logged on this exact date
    const weightRaw = weightResult.status === 'fulfilled' ? weightResult.value : null;
    const weightEntries = (weightRaw && weightRaw.dateWeightList) || [];
    const todayWeight = weightEntries.find(e => e.calendarDate === date);
    const weight = todayWeight ? { kg: +(todayWeight.weight / 1000).toFixed(1) } : null;

    return {
        type: 'daily',
        date,
        sleep,
        hr,
        wellness,
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
