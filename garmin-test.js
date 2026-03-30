#!/usr/bin/env node
/**
 * garmin-test.js — test harness for Garmin Connect API endpoints
 *
 * Usage:
 *   node garmin-test.js [--date YYYY-MM-DD] [--tests sleep,hr,steps,activities,weight,hydration]
 *
 * Credentials: ./garmin.credentials.json  { "email": "...", "password": "..." }
 * Session cache: ./garmin.session.json    (delete to force re-login)
 *
 * Available tests:
 *   sleep       - sleep duration, stages, score, HRV, body battery
 *   hr          - resting/max/min heart rate, 7-day avg
 *   steps       - total steps
 *   activities  - recent 10 activities (type, distance, duration)
 *   weight      - body weight, BMI, body fat (if tracked)
 *   hydration   - daily hydration (if tracked)
 *   all         - run everything (default)
 */
'use strict';

const { GarminConnect } = require('garmin-connect');
const fs   = require('fs');
const path = require('path');

const CREDS_FILE  = path.join(__dirname, 'garmin.credentials.json');
const TOKEN_DIR   = path.join(__dirname, 'garmin-tokens');

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = { tests: 'all' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--date')  args.date  = argv[i + 1];
        if (argv[i] === '--tests') args.tests = argv[i + 1];
    }
    return args;
}

function yesterday() {
    const d = new Date(Date.now() - 86400000);
    return d.getFullYear() + '-'
        + String(d.getMonth() + 1).padStart(2, '0') + '-'
        + String(d.getDate()).padStart(2, '0');
}

// API methods require Date objects; use noon local time to avoid timezone boundary issues
function toDate(dateStr) {
    return new Date(dateStr + 'T12:00:00');
}

function header(title) {
    console.log('\n' + '─'.repeat(60));
    console.log('  ' + title);
    console.log('─'.repeat(60));
}

function ok(label, value) {
    const display = value === null || value === undefined ? '(null)' : value;
    console.log('  ✓ ' + label + ': ' + display);
}

function raw(label, obj) {
    console.log('  ' + label + ':');
    console.log(JSON.stringify(obj, null, 4).split('\n').map(l => '    ' + l).join('\n'));
}

function fmtDur(secs) {
    if (!secs) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function getClient() {
    let creds;
    try {
        creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    } catch (e) {
        throw new Error('Cannot read ' + CREDS_FILE + ' — fill in your email and password.');
    }
    if (!creds.email || creds.email.startsWith('YOUR_')) {
        throw new Error('Edit garmin.credentials.json with your real email and password.');
    }

    const client = new GarminConnect({ username: creds.email, password: creds.password });

    const tokensExist = fs.existsSync(path.join(TOKEN_DIR, 'oauth1_token.json'))
                     && fs.existsSync(path.join(TOKEN_DIR, 'oauth2_token.json'));

    if (tokensExist) {
        try {
            console.log('  Restoring cached tokens from ' + TOKEN_DIR);
            client.loadTokenByFile(TOKEN_DIR);
        } catch (_) {
            console.log('  Cached tokens invalid, logging in fresh...');
            await client.login(creds.email, creds.password);
            client.exportTokenToFile(TOKEN_DIR);
        }
    } else {
        console.log('  No cached tokens, logging in...');
        await client.login(creds.email, creds.password);
        client.exportTokenToFile(TOKEN_DIR);
    }

    console.log('  Session ready.\n');
    return client;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testSleep(client, date) {
    header('SLEEP — ' + date);
    try {
        const data = await client.getSleepData(toDate(date));
        const dto  = (data && data.dailySleepDTO) || {};

        ok('durationSeconds',        dto.sleepTimeSeconds);
        ok('duration (formatted)',   fmtDur(dto.sleepTimeSeconds));
        ok('deepSleepSeconds',       dto.deepSleepSeconds);
        ok('lightSleepSeconds',      dto.lightSleepSeconds);
        ok('remSleepSeconds',        dto.remSleepSeconds);
        ok('awakeSleepSeconds',      dto.awakeSleepSeconds);
        ok('sleepScore',             dto.sleepScorePersonalized || dto.sleepScore);
        ok('restingHeartRate',       dto.restingHeartRate);
        ok('avgOvernightHrv',        data.avgOvernightHrv);
        ok('hrvStatus',              data.hrvStatus);
        ok('bodyBatteryChange',      data.bodyBatteryChange);
        ok('bodyBatteryMostRested',  data.bodyBatteryMostRested);

        console.log('\n  Raw dailySleepDTO keys:', Object.keys(dto).join(', '));
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

async function testHR(client, date) {
    header('HEART RATE — ' + date);
    try {
        const data = await client.getHeartRate(toDate(date));

        ok('restingHeartRate',              data.restingHeartRate);
        ok('maxHeartRate',                  data.maxHeartRate);
        ok('minHeartRate',                  data.minHeartRate);
        ok('lastSevenDaysAvgRestingHeartRate', data.lastSevenDaysAvgRestingHeartRate);
        ok('calendarDate',                  data.calendarDate);

        const vals = data.heartRateValues || [];
        console.log('  ✓ heartRateValues: ' + vals.length + ' data points');
        if (vals.length > 0) {
            console.log('    (first sample: ' + JSON.stringify(vals[0]) + ')');
        }

        console.log('\n  Raw top-level keys:', Object.keys(data || {}).join(', '));
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

async function testSteps(client, date) {
    header('STEPS — ' + date);
    try {
        const data = await client.getSteps(toDate(date));
        console.log('  Raw response: ' + JSON.stringify(data));
        ok('steps (extracted)', typeof data === 'number' ? data :
            (data && data.steps) ? data.steps : '(check raw above)');
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

async function testActivities(client) {
    header('RECENT ACTIVITIES (last 10)');
    try {
        const activities = await client.getActivities(0, 10);
        if (!Array.isArray(activities) || activities.length === 0) {
            console.log('  (no activities returned)');
            return;
        }
        console.log('  ' + activities.length + ' activities:');
        activities.forEach((a, i) => {
            const type  = (a.activityType && a.activityType.typeKey) || 'unknown';
            const name  = a.activityName || '(no name)';
            const dist  = a.distance ? (a.distance / 1000).toFixed(1) + ' km' : '-';
            const dur   = fmtDur(a.movingDuration || a.duration) || '-';
            const elev  = a.elevationGain ? Math.round(a.elevationGain) + ' m' : '-';
            const start = a.startTimeLocal || (a.startTimeInSeconds ? new Date(a.startTimeInSeconds * 1000).toISOString() : '-');
            console.log('  ' + (i + 1) + '. [' + type + '] ' + name);
            console.log('     dist=' + dist + ' dur=' + dur + ' elev=' + elev + ' start=' + start);
        });
        console.log('\n  Raw keys of first activity:', Object.keys(activities[0]).join(', '));
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

async function testWeight(client, date) {
    header('WEIGHT — most recent on or before ' + date);
    try {
        // getDailyWeightData only checks a single day; use dateRange to find most recent entry
        const d = toDate(date);
        const start = new Date(d.getTime() - 30 * 86400000);
        const fmt = dt => dt.getFullYear() + '-'
            + String(dt.getMonth() + 1).padStart(2, '0') + '-'
            + String(dt.getDate()).padStart(2, '0');
        const url = 'https://connectapi.garmin.com/weight-service/weight/dateRange'
            + '?startDate=' + fmt(start) + '&endDate=' + fmt(d);
        const data = await client.get(url);
        const entries = data.dateWeightList || [];
        if (entries.length === 0) {
            console.log('  (no weight entries in last 30 days)');
            return;
        }
        // entries are newest-first
        const latest = entries[0];
        ok('calendarDate',   latest.calendarDate);
        ok('weight (kg)',    latest.weight ? (latest.weight / 1000).toFixed(1) : null);
        ok('weight (raw g)', latest.weight);
        ok('bmi',            latest.bmi);
        ok('bodyFat',        latest.bodyFat);
        ok('sourceType',     latest.sourceType);
        console.log('\n  All entries in range (' + entries.length + '):');
        entries.forEach(e => console.log('    ' + e.calendarDate + ': ' + (e.weight / 1000).toFixed(1) + ' kg'));
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

async function testHydration(client, date) {
    header('HYDRATION — ' + date);
    try {
        const data = await client.getDailyHydration(toDate(date));
        console.log('  Raw response: ' + JSON.stringify(data));
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

async function testStress(client, date) {
    header('STRESS — ' + date);
    try {
        const url = 'https://connectapi.garmin.com/wellness-service/wellness/dailyStress/' + date;
        const data = await client.get(url);
        ok('averageStressLevel',  data.averageStressLevel);
        ok('maxStressLevel',      data.maxStressLevel);
        ok('stressQualifier',     data.stressQualifier);
        console.log('\n  Raw top-level keys:', Object.keys(data || {}).join(', '));
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

async function testSummary(client, date) {
    header('USER SUMMARY (intensity minutes + steps) — ' + date);
    try {
        const profile = await client.getUserProfile();
        const displayName = profile.displayName;
        ok('displayName', displayName);
        const url = 'https://connectapi.garmin.com/usersummary-service/usersummary/daily/'
                  + displayName + '?calendarDate=' + date;
        const data = await client.get(url);
        ok('totalSteps',               data.totalSteps);
        ok('moderateIntensityMinutes', data.moderateIntensityMinutes);
        ok('vigorousIntensityMinutes', data.vigorousIntensityMinutes);
        ok('floorsAscended',           data.floorsAscended);
        ok('averageStressLevel',       data.averageStressLevel);
        ok('bodyBatteryMostRested',    data.bodyBatteryMostRested);
        ok('bodyBatteryLeastRested',   data.bodyBatteryLeastRested);
        console.log('\n  Raw top-level keys:', Object.keys(data || {}).join(', '));
    } catch (e) {
        console.log('  ✗ FAILED: ' + e.message);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args  = parseArgs(process.argv.slice(2));
    const date  = args.date || yesterday();
    const tests = args.tests === 'all'
        ? ['sleep', 'hr', 'steps', 'activities', 'weight', 'hydration', 'stress', 'summary']
        : args.tests.split(',').map(s => s.trim());

    console.log('Garmin Connect API Test Harness');
    console.log('Date: ' + date + '  |  Tests: ' + tests.join(', '));
    console.log('');

    header('AUTH');
    const client = await getClient();

    for (const test of tests) {
        switch (test) {
            case 'sleep':      await testSleep(client, date);      break;
            case 'hr':         await testHR(client, date);         break;
            case 'steps':      await testSteps(client, date);      break;
            case 'activities': await testActivities(client);       break;
            case 'weight':     await testWeight(client, date);     break;
            case 'hydration':  await testHydration(client, date);  break;
            case 'stress':     await testStress(client, date);     break;
            case 'summary':    await testSummary(client, date);    break;
            default:
                console.log('\n  Unknown test: ' + test);
        }
    }

    console.log('\n' + '─'.repeat(60));
    console.log('Done.');
}

main().catch(e => {
    console.error('\nFATAL: ' + (e.message || String(e)));
    process.exit(1);
});
