const logger = require('./logger');
const {prisma} = require('./prisma');
const Decimal = require('decimal.js');
const ethers = require('ethers');
const crypto = require('crypto');

const TOKEN_DECIMAL = 18;
const PRICISION_UNIT = TOKEN_DECIMAL + 12;
const USDBTC = 'USDBTC';

function appendZero(v, p) {
    let s = '' + v;
    for (let i = 0; i < p; i++)
        s += '0';
    return s;
}

async function saveFeeds (providerRec, jsonBody) {
    try {
        const bnOnePricisionUnit = BigInt(appendZero(1, PRICISION_UNIT));
        let dateNow = new Date();
        let now = Math.floor(dateNow.getTime() / 1000);

        let quotes = jsonBody.data.quotes;
        if (!quotes)
            return {error: 'Required quotes on JSON body data element'};
        if (!quotes[USDBTC])
            return {error: 'Missing USDBTC in quotes element'};
        if (Object.keys(quotes).length < parseInt(providerRec.feed_size, 10))
            return {error: 'quotes size '+Object.keys(quotes).length+'is less than '+providerRec.feed_size};
        if (providerRec.paused)
            return {error: 'Paused provider'};
        if (parseInt(providerRec.disabled_timestamp, 10) > 0) {
            if (now > parseInt(providerRec.disabled_timestamp, 10))
                return {error: 'Disabled provider'};
        }

        let submissionTimestamp = parseInt(jsonBody.data.timestamp, 10);
        if (submissionTimestamp > now)
            return {error: 'Invalid data.timestamp value'};

        let lastSubmission = await prisma.feed_submission.findFirst({
            where: {
                feed_provider_id: providerRec.id
            },
            orderBy: {
                created_datetime: 'desc'
            }
        });
        if (lastSubmission) {
            if (submissionTimestamp <= lastSubmission.feed_timestamp)
                return {error: 'Outdated feed'};
        }

        let newSubmission = await prisma.feed_submission.create({
            data: {
                id: crypto.randomUUID(),
                created_datetime: dateNow.toISOString(),
                feed_provider_id: providerRec.id,
                feed_timestamp: parseInt(jsonBody.data.timestamp, 10),
                json_content: JSON.stringify(jsonBody)
            }
        });

        let usdbtcRate = ethers.parseUnits(new Decimal(quotes[USDBTC]).toString(), TOKEN_DECIMAL);
        let btcusdRate = (bnOnePricisionUnit * bnOnePricisionUnit) / usdbtcRate;

        let tabCount = 0;
        let pricePairRecs = [];
        for (const key in quotes) {
            let v1 = new Decimal(quotes[key]);
            if (v1.isNaN())
                return {error: 'Invalid '+key};

            let v2 = ethers.parseUnits(v1.toString(), TOKEN_DECIMAL);
            let price = 0;

            let strTab = '';
            if (key.length == 3)
                strTab = key.toUpperCase();
            else if (key.length == 6)
                strTab = key.substring(3).toUpperCase(); // e.g. USDJPY, strTab = JPY
            else
                return {error: 'Invalid quotes item '+key};    

            let tab = ethers.dataSlice(ethers.toUtf8Bytes(strTab), 0, 3); // bytes3 equivalent

            if (key.indexOf(USDBTC) > -1) {
                // incoming USDBTC key is converted to USD tab
                strTab = 'USD';                
                price = btcusdRate / BigInt(appendZero(1, PRICISION_UNIT + PRICISION_UNIT - TOKEN_DECIMAL - TOKEN_DECIMAL));
            } else // On PriceOracle contract, all prices are representing BTC/TAB rate.
                price = (btcusdRate * v2) / BigInt(appendZero(1, PRICISION_UNIT + (PRICISION_UNIT - TOKEN_DECIMAL)));

            if (price == 0) {
                logger.error('Zero price on currency ' + strTab + '. v1: ' + v1 + ' v2: ' + v2 + ' btcusdRate: ' + btcusdRate.toString());
                return {error: 'Invalid zero value from price calculation on key '+key};
            }

            pricePairRecs.push({
                id: crypto.randomUUID(),
                feed_submission_id: newSubmission.id,
                base_currency: 'BTC',
                pair_name: strTab,
                price: price.toString()
            });

            tabCount++;
        }

        let newPrices = await prisma.price_pair.createMany({
            data: pricePairRecs
            // skipDuplicates: true
        });
        logger.info('New submission id '+newSubmission.id+' tab count: '+tabCount);

        return {
            'provider': providerRec.pub_address,
            'processed_count': tabCount
        }
    } catch(e) {
        logger.error(e);
        return {error: 'Internal server error'};
    }
}

exports.feedSubmissionJob = {
    saveFeeds
}