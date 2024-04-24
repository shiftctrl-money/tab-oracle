CREATE SCHEMA IF NOT EXISTS tabdb AUTHORIZATION tabdb;

ALTER DATABASE tabdb SET search_path TO tabdb;

DROP TABLE IF EXISTS tabdb.feed_provider;
CREATE TABLE tabdb.feed_provider (
	id character varying(100) NOT NULL,
	created_datetime timestamp NOT NULL,
	updated_datetime timestamp,
	pub_address VARCHAR(100) NOT NULL,
	index VARCHAR(78) NOT NULL,
	activated_since_block VARCHAR(78) NOT NULL,
	activated_timestamp VARCHAR(78) NOT NULL,
	disabled_since_block VARCHAR(78),
	disabled_timestamp VARCHAR(78),
	paused BOOLEAN,
	payment_token_address VARCHAR(100) NOT NULL,
	payment_amount_per_feed VARCHAR(78) NOT NULL,
	block_count_per_feed VARCHAR(78) NOT NULL,
	feed_size VARCHAR(78) NOT NULL,
	whitelisted_ip VARCHAR(30),
	CONSTRAINT "UNIQ_PUB_ADDR" UNIQUE (pub_address),
	CONSTRAINT "PK_FEED_PROVIDER" PRIMARY KEY (id)
);

DROP TABLE IF EXISTS tabdb.auth;
CREATE TABLE tabdb.auth (
	id character varying(100) NOT NULL,
	created_datetime timestamp NOT NULL,
	updated_datetime timestamp,
	user_id character varying(100) NOT NULL,
	api_token character varying(200) NOT NULL,
	CONSTRAINT "UNIQ_AUTH_USER_ID" UNIQUE (user_id),
	CONSTRAINT "PK_AUTH" PRIMARY KEY (id)
);

DROP TABLE IF EXISTS tabdb.feed_submission;
CREATE TABLE tabdb.feed_submission (
	id character varying(100) NOT NULL,
	created_datetime timestamp NOT NULL,
	feed_provider_id character varying(100) NOT NULL,
	feed_timestamp bigint,
	json_content TEXT NOT NULL,
	CONSTRAINT "FK_FEED_PROV" FOREIGN KEY (feed_provider_id) REFERENCES tabdb.feed_provider (id) MATCH FULL,
	CONSTRAINT "PK_FEED_SUBMISSION" PRIMARY KEY (id)
);

DROP TABLE IF EXISTS tabdb.price_pair;
CREATE TABLE tabdb.price_pair (
	id character varying(100) NOT NULL,
	feed_submission_id character varying(100) NOT NULL,
	base_currency CHAR(3) NOT NULL,
	pair_name CHAR(3) NOT NULL,
	price VARCHAR(78) NOT NULL,
	CONSTRAINT "FK_FEED_SUB" FOREIGN KEY (feed_submission_id) REFERENCES tabdb.feed_submission (id) MATCH FULL,
	CONSTRAINT "PK_PRICE_PAIR" PRIMARY KEY (id)
);

DROP TABLE IF EXISTS tabdb.median_batch;
CREATE TABLE tabdb.median_batch (
	id character varying(100) NOT NULL,
	created_datetime timestamp NOT NULL,
	batch_interval_sec int,
	cid VARCHAR(100),
	trx_ref TEXT,
	CONSTRAINT "PK_MEDIAN_BATCH" PRIMARY KEY (id)
);

DROP TABLE IF EXISTS tabdb.median_price;
CREATE TABLE tabdb.median_price (
	id character varying(100) NOT NULL,
	median_batch_id character varying(100) NOT NULL,
	base_currency CHAR(3) NOT NULL,
	pair_name CHAR(3) NOT NULL,
	median_value VARCHAR(78) NOT NULL,
	slot_0 character varying(100),
	slot_1 character varying(100),
	slot_2 character varying(100),
	slot_3 character varying(100),
	slot_4 character varying(100),
	slot_5 character varying(100),
	slot_6 character varying(100),
	slot_7 character varying(100),
	slot_8 character varying(100),
	active_slot int,
	feeds TEXT,
	CONSTRAINT "FK_MEDIAN_BATCH" FOREIGN KEY (median_batch_id) REFERENCES tabdb.median_batch (id) MATCH FULL,
	CONSTRAINT "PK_MEDIAN_PRICE" PRIMARY KEY (id)
);

DROP TABLE IF EXISTS tabdb.tab_registry;
CREATE TABLE tabdb.tab_registry (
	id character varying(100) NOT NULL,
	tab_name CHAR(3) NOT NULL,
	tab_code CHAR(8) NOT NULL,
	curr_name VARCHAR(200),
	is_clt_alt_del BOOLEAN,
	is_tab BOOLEAN,
	missing_count int,
	revival_count int,
	frozen BOOLEAN,
	CONSTRAINT "UNIQ_TAB_NAME" UNIQUE (tab_name),
	CONSTRAINT "PK_TAB_REGISTRY" PRIMARY KEY (id)
);

DROP TABLE IF EXISTS tabdb.provider_performance;
CREATE TABLE tabdb.provider_performance (
	id character varying(100) NOT NULL,
	created_datetime timestamp NOT NULL,
	provider_count int,
	providers TEXT,
	feed_counts TEXT,
	trx_ref VARCHAR(100),
	CONSTRAINT "PK__PROV_PERFORMANCE" PRIMARY KEY (id)
);
