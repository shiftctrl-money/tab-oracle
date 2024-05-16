const logger = require('./logger');

const {
    NODE_ENV,
    EXPRESS_PORT,
    BC_NODE_URL,
    BC_KEEPER_PRIVATE_KEY,
    BC_TAB_REGISTRY_CONTRACT,
    BC_PRICE_ORACLE_MANAGER_CONTRACT,
    NFT_STORAGE_API_KEY,
    CURR_DETAILS,
    AUTH_SECRET,
    AUTH_IV,
    PRIVATE_TOKEN
} = require('./config');
const { params } = require('./params');
const { feedSubmissionJob } = require('./feedSubmission');
const { medianPrice } = require('./medianPrice');
const { providerPerformanceJob } = require('./providerPerformance');
const { auth } = require('./auth');

const cron = require('node-cron');

const express = require('express');
const app = express();
app.use(express.json());

const AUTH_ERROR = 'Authentication failed';

function timestampNow() {
    return Math.floor(Date.now() / 1000);
}

function resError(strError) {
    return {
        timestamp: timestampNow(),
        data: { error: strError }
    }
}

function resData(jsonData) {
    return {
        timestamp: timestampNow(),
        data: jsonData
    }
}

// Registered oracle provider whitelisted IP address only
app.post(`/api/v1/auth/create_or_reset_api_token/:provAddr`, async (req, res) => {
    const { provAddr } = req.params;
    let authResult = auth.validateSubmission(req.headers, req.body, params.provMap[provAddr]);
    if (authResult.error) {
        console.error(authResult.error);
        res.status(400).json(resError(authResult.error));
    } else {
        const resetResult = await auth.createOrResetApiKey(req.headers, params.provMap[provAddr], req.body, AUTH_SECRET, AUTH_IV);
        if (resetResult.error) {
            res.status(400).json(resError(resetResult.error));
        } else {
            res.json(resData({
                provider: provAddr,
                api_token: resetResult.api_token
            }));
        }
    }
});

// Protected endpoint: Registered oracle provider only
app.post(`/api/v1/feed_provider/:provAddr/feed_submission`, async (req, res) => {
    const { provAddr } = req.params;
    if (params.provMap[provAddr]) {
        if (!params.provMap[provAddr].auth) {
            res.status(401).json(resError(AUTH_ERROR));
            return;
        }
    } else {
        res.status(401).json(resError(AUTH_ERROR));
        return;
    }

    if (auth.verifyApiKey(req.headers['x-api-token'], AUTH_SECRET, AUTH_IV, params.provMap[provAddr].auth.api_token)) {
        let authResult = auth.validateSubmission(req.headers, req.body, params.provMap[provAddr]);
        if (authResult.error) {
            console.error(authResult.error);
            res.status(400).json(resError(authResult.error));
        } else {
            let submissionResult = await feedSubmissionJob.saveFeeds(params.provMap[provAddr], req.body);
            res.json(resData(submissionResult));
        }
    } else {
        res.status(401).json(resError(AUTH_ERROR));
    }
});

app.get(`/api/v1/tab/list`, async (req, res) => {
    res.json(resData(await params.getTabDetails()));
});

// Protected endpoint
app.get(`/api/v1/median_price`, async (req, res) => {
    logger.info('median_price request from ' + req.headers['x-real-ip']);
    if (auth.verifyApiKey(req.headers['x-api-token'], AUTH_SECRET, AUTH_IV, PRIVATE_TOKEN)) {
        res.json(await medianPrice.getLiveMedianPrices(req.query.details == '1'));
    } else {
        res.status(401).json(resError(AUTH_ERROR));
    }
});

// Protected endpoint
app.get(`/api/v1/feed_provider/list`, async (req, res) => {
    logger.info('feed_provider list request from ' + req.headers['x-real-ip']);
    if (auth.verifyApiKey(req.headers['x-api-token'], AUTH_SECRET, AUTH_IV, PRIVATE_TOKEN)) {
        res.json(resData(params.getProviderDetails()));
    } else {
        res.status(401).json(resError(AUTH_ERROR));
    }
});

const server = app.listen(EXPRESS_PORT, () => {
    logger.info("tab-oracle is started, listen port: " + EXPRESS_PORT);
});

async function main() {

    await params.cacheParamsJob(
        BC_NODE_URL,
        BC_PRICE_ORACLE_MANAGER_CONTRACT,
        BC_TAB_REGISTRY_CONTRACT
    );

    if (NODE_ENV == 'local') {

        // await params.retrieveAndSaveCurrencySymbols(CURR_DETAILS);

        // every minute
        cron.schedule('* * * * *', async () => {
            await params.cacheParamsJob(BC_NODE_URL, BC_PRICE_ORACLE_MANAGER_CONTRACT, BC_TAB_REGISTRY_CONTRACT);
            
            await medianPrice.groupAndSendMedianPrices(BC_NODE_URL, BC_KEEPER_PRIVATE_KEY, BC_PRICE_ORACLE_MANAGER_CONTRACT, BC_TAB_REGISTRY_CONTRACT, NFT_STORAGE_API_KEY);

            await providerPerformanceJob.submitProvPerformance(BC_NODE_URL, BC_KEEPER_PRIVATE_KEY, BC_PRICE_ORACLE_MANAGER_CONTRACT, params.provMap);
        });
    } else {
        await params.retrieveAndSaveCurrencySymbols(CURR_DETAILS);

        // every 5 minutes, e.g. 1.00 1.05, 1.10, 2.55, 3.00
        cron.schedule('*/5 * * * *', async () => {

            await params.cacheParamsJob(BC_NODE_URL, BC_PRICE_ORACLE_MANAGER_CONTRACT, BC_TAB_REGISTRY_CONTRACT);

            await medianPrice.groupAndSendMedianPrices(BC_NODE_URL, BC_KEEPER_PRIVATE_KEY, BC_PRICE_ORACLE_MANAGER_CONTRACT, BC_TAB_REGISTRY_CONTRACT, NFT_STORAGE_API_KEY);
        });

        // every 1 hour, e.g. 1.01, 2.01, 3.01
        cron.schedule('1 * * * *', async () => {
            await providerPerformanceJob.submitProvPerformance(BC_NODE_URL, BC_KEEPER_PRIVATE_KEY, BC_PRICE_ORACLE_MANAGER_CONTRACT, params.provMap);
        });
    }

    // every 24 hours, e.g. every 00:02
    cron.schedule('2 */24 * * *', async () => {
        await params.retrieveAndSaveCurrencySymbols(CURR_DETAILS);
    });
}

main();
