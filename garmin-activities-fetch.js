#!/usr/bin/env node
/**
 * garmin-activities-fetch.js — fetch activity list from Garmin Connect
 *
 * Usage:
 *   node garmin-activities-fetch.js [--limit N]
 *   node garmin-activities-fetch.js --start YYYY-MM-DD --end YYYY-MM-DD
 *
 * Config: ./garmin.credentials.json  { "email": "...", "password": "..." }
 * Tokens: ./garmin-tokens/            (auto-managed)
 *
 * Outputs a JSON array of activity objects to stdout.
 */
'use strict';

// Redirect console.log to stderr so library noise doesn't pollute JSON stdout
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');

const { GarminConnect } = require('garmin-connect');
const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'garmin.credentials.json');
const TOKEN_DIR   = path.join(__dirname, 'garmin-tokens');

function resolveType(typeKey) {
    const map = {
        cycling: 'Ride', road_biking: 'Ride', mountain_biking: 'Ride',
        gravel_cycling: 'Ride', virtual_ride: 'Ride', indoor_cycling: 'Ride',
        e_sport_cycling: 'Ride', e_bike_fitness: 'Ride',
        running: 'Run', treadmill_running: 'Run', trail_running: 'Run',
        indoor_running: 'Run', street_running: 'Run',
        walking: 'Walk', casual_walking: 'Walk', speed_walking: 'Walk',
        hiking: 'Hike',
        swimming: 'Swim', lap_swimming: 'Swim', open_water_swimming: 'Swim',
        strength_training: 'Strength', cardio_training: 'Cardio',
        yoga: 'Yoga', pilates: 'Pilates',
        fitness_equipment: 'Fitness',
    };
    if (!typeKey) return 'Activity';
    const k = typeKey.toLowerCase();
    return map[k] || k.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function toHMS(secs) {
    if (!secs) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] && argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            args[key] = argv[i + 1] || '';
            i++;
        }
    }
    return args;
}

async function getClient() {
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        throw new Error('Cannot read ' + CONFIG_FILE + ' — run the Setup inject node first.');
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

async function fetchActivities(client, args) {
    const PAGE_SIZE = 100;
    const startMs = args.start ? new Date(args.start).getTime()              : null;
    const endMs   = args.end   ? new Date(args.end + 'T23:59:59').getTime() : null;
    const maxResults = args.limit ? parseInt(args.limit, 10) : (startMs || endMs ? 10000 : 50);

    const gearCache = {};

    async function lookupGear(activityId) {
        if (gearCache[activityId] !== undefined) return gearCache[activityId];
        try {
            const url = 'https://connectapi.garmin.com/gear-service/gear/filterGear?activityId=' + activityId;
            const data = await client.get(url);
            const list = Array.isArray(data) ? data : (data && data.gearList) || [];
            gearCache[activityId] = list.length > 0
                ? (list[0].displayName || list[0].customMakeModel || null)
                : null;
        } catch (_) {
            gearCache[activityId] = null;
        }
        return gearCache[activityId];
    }

    const result = [];
    let startIndex = 0;
    let paginationDone = false;

    while (!paginationDone) {
        const batch = await client.getActivities(startIndex, PAGE_SIZE);
        if (!Array.isArray(batch) || batch.length === 0) break;

        for (const a of batch) {
            // beginTimestamp is epoch ms; startTimeInSeconds is epoch seconds
            const ts = a.beginTimestamp || (a.startTimeInSeconds ? a.startTimeInSeconds * 1000 : null);

            // Activities are returned newest-first, so once we go past startMs we're done
            if (startMs && ts && ts < startMs) { paginationDone = true; break; }
            // Skip activities after endMs
            if (endMs && ts && ts > endMs) continue;

            const typeKey  = (a.activityType && a.activityType.typeKey) || '';
            const type     = resolveType(typeKey);

            // startTimeLocal format: "2026-03-20 09:07:34"
            const stl      = a.startTimeLocal || '';
            const spaceIdx = stl.indexOf(' ');
            const datePart = spaceIdx !== -1 ? stl.substring(0, spaceIdx) : stl;
            const timePart = spaceIdx !== -1 ? stl.substring(spaceIdx + 1) : null;

            let dow = null;
            if (datePart) {
                try {
                    dow = new Date(datePart + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
                } catch (_) {}
            }

            const gearName = await lookupGear(a.activityId);

            result.push({
                activityId:    a.activityId,
                date:          datePart || null,
                type:          type,
                sport_type:    typeKey || null,
                gear:          gearName,
                name:          a.activityName || '',
                dist_km:       a.distance      ? +(a.distance / 1000).toFixed(2)    : null,
                elv_m:         a.elevationGain ? Math.round(a.elevationGain)         : null,
                elapsed_time:  toHMS(a.duration),
                moving_time:   toHMS(a.movingDuration || a.duration),
                start_time:    timePart || null,
                day_of_week:   dow,
                speed_kmh:     a.averageSpeed  ? +(a.averageSpeed * 3.6).toFixed(1) : null,
                max_speed_kmh: a.maxSpeed      ? +(a.maxSpeed     * 3.6).toFixed(1) : null,
                avg_hr:        a.averageHR                                           || null,
                max_hr:        a.maxHR                                               || null,
                calories:      a.calories      ? Math.round(a.calories)              : null,
                elv_loss_m:    a.elevationLoss ? Math.round(a.elevationLoss)         : null,
                aerobic_te:    (a.aerobicTrainingEffect   != null && !isNaN(+a.aerobicTrainingEffect))   ? +(+a.aerobicTrainingEffect).toFixed(1)   : null,
                anaerobic_te:  (a.anaerobicTrainingEffect != null && !isNaN(+a.anaerobicTrainingEffect)) ? +(+a.anaerobicTrainingEffect).toFixed(1) : null,
                vo2max:        a.vO2MaxValue                                         || null,
                avg_power:     a.avgPower                                            || null,
                cadence:       Math.round(a.averageBikingCadenceInRevPerMinute || a.averageRunningCadenceInStepsPerMinute || 0) || null,
            });

            if (result.length >= maxResults) { paginationDone = true; break; }
        }

        if (batch.length < PAGE_SIZE) break;   // last page
        startIndex += PAGE_SIZE;
    }

    return result;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const client = await getClient();
    const activities = await fetchActivities(client, args);
    process.stdout.write(JSON.stringify(activities) + '\n');
}

main().catch(e => {
    process.stderr.write((e.message || String(e)) + '\n');
    process.exit(1);
});
