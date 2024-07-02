
-- Run on 12.05am, only retain ONE day data
delete from active_median where last_updated < (DATE(NOW()) - 1);

delete from median_price where id in (
select mp.id from median_price mp , median_batch mb 
where mp.median_batch_id = mb.id and mb.created_datetime < (DATE(NOW()) - 1));

delete from median_batch where created_datetime < (DATE(NOW()) - 1);

delete from price_pair where id in (
select pp.id from price_pair pp , feed_submission fs2 
where pp.feed_submission_id = fs2.id and fs2.created_datetime  < (DATE(NOW()) - 1));

delete from feed_submission where created_datetime  < (DATE(NOW()) - 1);
