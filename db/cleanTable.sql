
-- Run on 12.05am, only retain ONE day data
delete from active_median where last_updated < (DATE(NOW()) - 1);

delete from median_price mpp where mpp.median_batch_id in (
select mb.id from median_batch mb where mb.created_datetime < (DATE(NOW()) - 1));

delete from median_batch where created_datetime < (DATE(NOW()) - 1);

delete from price_pair where feed_submission_id in (
select fs2.id from feed_submission fs2 
where fs2.created_datetime  < (DATE(NOW()) - 1));

delete from feed_submission where created_datetime  < (DATE(NOW()) - 1);
