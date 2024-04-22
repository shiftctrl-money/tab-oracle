
# Tab Oracle

The Tab Oracle module is a part of Tab Protocol that receives currrency rates from authorized providers, and submit all rates for median value calculation on-chain.

![overview](https://lh3.googleusercontent.com/drive-viewer/AKGpihZ6COG8RFCvMdFgMbikNKBOVbYUkyuZjjMgN6ujTe3pDgyjpTDMg3fYHkN_83bjk4Lo-2I7bQWKYAeE-9ieuO4OdGDXQvAh3Q=s2560)


## Sub-modules
| Name    | Description | Scheduler |
| ------- | ----------- | --------- |
| Feed submission | Authenticate, validate, and store currency rates sent by authorized provider | Adhoc|
| On/off-chain params | Sync. on-chain and off-chain parameters/configuration | Run on every 5 minutes |
| Price submission | Group currency rates, upload snapshot to IPFS, and submit price data on-chain | Run on every 5 minutes |
| Provider performance | Track provider submissions and submit data on-chain. Provider claims payment based on submitted data | Run on every 60 minutes|


## API Endpoints
| Endpoint | Description |
| -------- | ----------- |
| /api/v1/auth/create_or_reset_api_token/[provider_pub_address] | Authorized provider calls this endpoint to generate or reset API token to submit currrency rate data |
| /api/v1/feed_provider/[provider_pub_address]/feed_submission | Authorized provider calls this endpoint to submit currency rate data |
| /api/v1/tab/list | Retrieve Tab details |
| /api/v1/median_price | Protected endpoint reserved for internal usage (e.g. used by tab-ui module) |
| /api/v1/feed_provider/list | Protected endpoint reserved for internal usage (e.g. used by tab-ui module) |


## Getting Started

### Prerequisites
* EVM blockchain with Node URL
* Tab protocol deployment, smart contract address for PriceOracleManager and TabRegistry.
* Registered / activated Tab Oracle Provider in smart contract. Provider is identified by an unique public address.
* Node.js
* PostgreSQL, or other databases supported by Prisma (refer [this](https://www.prisma.io/docs/orm/overview/databases))

### Installation
Refer steps below:

1. Clone the repo ``` git clone [repo] ```
2. cd into tab-oracle directory
   ```sh
   cd tab-oracle 
   ```
3. Install NPM packages
   ```sh
   npm install
   ```
4. Edit .env.local file to suit your environment. 

5. Initialize PostgreSQL database and ready to accept connection.

6. Introspect database with command
   ```sh
   npx prisma db pull
   ```
   then generate Prisma Client with command
   ```sh
   npx prisma generate
   ```
7. Start application
   ```sh
   npm run local
   ```

### Docker
You may execute this module in docker environment. 
Example below assumes that related dependencies (such as EVM blockchain or database) are running in dockerized container joined on same network(`tab-net`). 
Docker swarm mode is preferred so that we can utilize docker secret to hide sensitive data.

1. Install docker and run
   ```sh
   docker swarm init
   docker network create --driver overlay tab-net
   ```

2. Clone the repo ``` git clone [repo] ```

3. Switch into tab-oracle directory
   ```sh
   cd tab-oracle 
   ```
4. Create and edit .env file by referring to .env.local file based on your environment. The .env file will be saved as docker secret in following step.

5. Run commands to start docker,
   ```sh
   docker volume create tab-oracle-log
   docker secret create tab-oracle-env .env
   docker build . -t tab-oracle
   docker service create --name tab-oracle --network tab-net --replicas 1 \
   --hostname tab-oracle --secret src=tab-oracle-env,target=".env" \
   -p 9090:9090 --mount src=tab-oracle-log,dst=/usr/src/app/logs tab-oracle:latest
   ```
6. Visit [Docker swarm](https://docs.docker.com/engine/swarm/) for reference.

#### Nginx reversed proxy (Optional)
1. Remove `-p 9090:9090` option when running docker service create. Published port is used on Nginx container instead.

2. Edit nginx.conf with sample proxy option:
   ```
   real_ip_header    X-Real-IP;
   real_ip_recursive on;

   server {
    server_name api.shiftctrl.money;
    location / {
      proxy_pass http://tab-oracle:9090;
      proxy_buffering off;
      proxy_set_header X-Real-IP  $remote_addr;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_set_header Host $host;
      proxy_pass_request_headers  on;
    }

    listen 80;
   }
   ```
3. Run command to start nginx,
   ```sh
   docker volume create tab-nginx
   docker service create --name tab-nginx -p 80:80 --network tab-net \
   --replicas 1 --hostname tab-nginx --mount src=tab-nginx,dst=/etc/nginx tab-nginx:latest
   ```

#### PostgreSQL Docker Setup
1. Create a new volume
   ```sh
   docker volume create tabdb
   ```
2. Create a DB password file and store it in docker secret
   ```sh
   echo "my_DB_Secret_Password" >> postgres-passwd
   docker secret create postgres-passwd ./postgres-passwd
   ```
3. Create a new volume to put database initialization script
   ```sh
   docker volume create tabdb-init
   
   # assume docker volume in default location /var/lib/docker/volumes
   cp db/tabdb.sql /var/lib/docker/volumes/tabdb-init/_data
   ```
4. Run docker service create command
   ```sh
   docker service create --name tabdb --hostname tabdb -p 5432:5432 --network tab-net \
   --replicas 1 --secret src=postgres-passwd,target="postgres-passwd" \
   -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-passwd -e POSTGRES_USER=tabdb \
   -e PGDATA=/var/lib/postgresql/data/pgdata -e LANG=en_US.utf8 \
   -e POSTGRES_INITDB_ARGS="--locale-provider=icu --icu-locale=en-US" \
   --mount src=tabdb,dst=/var/lib/postgresql/data/pgdata \
   --mount src=tabdb-init,dst=/docker-entrypoint-initdb.d \
   postgres:16.2-bullseye
   ```
5. Verify service is running 
   ```sh
   # expected mode "replicated"
   docker service ls
   
   # expected status "up"
   docker ps -a      
   ```

## Contributing

Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. 
You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License
Distributed under the MIT License. See `LICENSE.md` for more information.

## Contact
Project Link: [https://shiftctrl.money](https://shiftctrl.money) - contact@shiftctrl.money

Twitter [@shiftCTRL_money](https://twitter.com/shiftCTRL_money) 

Discord [shiftctrl_money](https://discord.gg/7w6JhTNt9K)

