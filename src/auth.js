const logger = require('./logger');
const {prisma} = require('./prisma');
const ethers = require('ethers');
const crypto = require('crypto');

const algorithm = 'aes-256-cbc';

function createApiKey() {
    return crypto.randomBytes(32).toString('hex').substring(0, 32);
}

function encrypt(data, secretKey, strIV) {
    const iv = Buffer.from(new TextEncoder().encode(strIV)); // crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, Buffer.from(secretKey, 'hex'), iv);
    let encryptedData = cipher.update(data, 'utf8', 'hex');
    encryptedData += cipher.final('hex');
    return `${iv.toString('hex')}:${encryptedData}`;
}

function decrypt(encryptedData, secretKey) {
    const [iv, data] = encryptedData.split(':');
    const decipher = crypto.createDecipheriv(algorithm, Buffer.from(secretKey, 'hex'), Buffer.from(iv, 'hex'));
    let decryptedData = decipher.update(data, 'hex', 'utf8');
    decryptedData += decipher.final('utf8');
    return decryptedData;
}

function validateSubmission(reqHeaders, jsonBody, provider) {
    if (!reqHeaders['x-real-ip'])
        return {error: 'Required x-real-ip header'};
    if (!jsonBody)
        return {error: 'Required JSON body content'};
    if (!jsonBody.data)
        return {error: 'Required data element on JSON body'};
    if (!jsonBody.data.provider)
        return {error: 'Required provider on JSON body data element'};
    if (!jsonBody.signature)
        return {error: 'Required signature on JSON body data element'};
    if (!provider)
        return {error: 'Internal error: missing feed provider record'};

    var incomingIps = reqHeaders['x-real-ip'];
    var ips = provider.whitelisted_ip.split(',');
    var bMatched = false;
    for (var i = 0; i < ips.length; i++) {
        if (incomingIps.indexOf(ips[i]) > -1) {
            bMatched = true;
            break;
        }
    }
    if (provider.whitelisted_ip) {
        if (!bMatched) {
            logger.info('BLOCKED ACCESS FROM: '+ incomingIps);
            return {error: 'Unauthorized IP address'};
        }
    }
    if (provider.pub_address != jsonBody.data.provider)
        return {error: 'Internal error: unmatched provider address'};
    
    try {
        const payload = JSON.stringify(jsonBody.data);
        const recoveredAddress = ethers.verifyMessage(ethers.id('\x19Ethereum Signed Message:\n' + payload.length + payload), jsonBody.signature);
        if (provider.pub_address != recoveredAddress)
            return {error: 'Invalid signature'};
    } catch(e) {
        logger.error(e);
        return {error: e};
    }

    return {passed: 1};
}

async function createOrResetApiKey(reqHeaders, provider, jsonBody, secretKey, strIV) {
    let newApiKey = createApiKey();
    try {
        if (!newApiKey || !secretKey)
            return {error: 'Internal server error'};
        if (!provider)
            return {error: 'Provider is not found'};

        let encryptedApiKey = encrypt(newApiKey, secretKey, strIV);
        if (!reqHeaders['x-real-ip'])
            return {error: 'Required x-real-ip header'};
        if (provider.whitelisted_ip) {
            var incomingIps = reqHeaders['x-real-ip'];
            var ips = provider.whitelisted_ip.split(',');
            var bMatched = false;
            for (var i = 0; i < ips.length; i++) {
                if (incomingIps.indexOf(ips[i]) > -1) {
                    bMatched = true;
                    break;
                }
            }
            if (!bMatched) {
                logger.info('Unauthorized createOrResetApiKey from: '+ incomingIps);
                return {error: 'Unauthorized IP address'};
            }
        }

        if (!jsonBody.data.timestamp)
            return {error: 'Required timestamp on JSON body data element'};
        let now = Math.floor(new Date().getTime() / 1000);
        let elapsed = now - parseInt(jsonBody.data.timestamp, 10);
        if (elapsed < 0 || elapsed > 4) // Not accepted if supplied timestamp value exceeded(older) 3 seconds
            return {error: 'Invalid data.timestamp value'};

        let dateNow = new Date();
        let authDetails = {
            updated_datetime: dateNow.toISOString(),
            api_token: encryptedApiKey
        };
        let result = await prisma.auth.upsert({
            where: {
                user_id: provider.pub_address
            },
            update: authDetails,
            create: {
                id: crypto.randomUUID(),
                created_datetime: dateNow.toISOString(),
                updated_datetime: dateNow.toISOString(),
                user_id: provider.pub_address,
                api_token: encryptedApiKey
            }
        });
        if (result) {
            logger.info("Done createOrResetApiKey on provider: "+ provider.pub_address);

            // update auth cache
            provider.auth = authDetails;

        } else {
            logger.error('ERROR invalid result on resetApiKeyJob for provider: '+provider.pub_address+' result: '+result);
            return {error: 'Internal Error: database write'};
        }

        return {'encryptedApiKey': encryptedApiKey, 'api_token': newApiKey};

    } catch(e) {
        logger.error(e);
        return {error: e};
    }
};

exports.auth = {
    verifyApiKey: (apiKey, secret, strIV, encrypted) => {
        try {
            if (!apiKey || !secret || !strIV || !encrypted)
                return 0;
            return encrypt(apiKey, secret, strIV) == encrypted;
        } catch(error) {
            logger.error(error);
            return 0;
        }
    },
    validateSubmission,
    createOrResetApiKey
}