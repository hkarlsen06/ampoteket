-- Newsroom and event calendar: staff writes, public reads and their boundaries.
\set ON_ERROR_STOP on
BEGIN;
\ir fixtures.sql
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  RAISE NOTICE 'PASS: %',label;
END $$;
CREATE FUNCTION pg_temp.expect_error(statement text,message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    IF position(message in SQLERRM)=0 THEN RAISE EXCEPTION 'Wrong error: %',SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'Expected error: %',message;
END $$;
-- A complete row as the editor sends it; tests override single fields.
CREATE FUNCTION pg_temp.article(p_changes jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id','79000000-0000-4000-8000-000000000001','slug','soldering-night','title','Soldering night',
    'summary','Learn to solder.','body',E'First paragraph.\n\nSecond paragraph.',
    'images',jsonb_build_array(jsonb_build_object('id','78000000-0000-4000-8000-000000000001','alt','Two people soldering')),
    'links',jsonb_build_array(jsonb_build_object('label','Sign up','url','https://example.invalid/signup')),
    'people',jsonb_build_array('76100000-0000-4000-8000-000000000002','76100000-0000-4000-8000-000000000001'),
    'is_published',false,'expected_revision',NULL) || p_changes
$$;
CREATE FUNCTION pg_temp.event(p_changes jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id','7a000000-0000-4000-8000-000000000001','slug','soldering-night','title','Soldering night',
    'description','Bring a project.','location','PS126','starts_at','2026-11-05T18:00:00+01:00','ends_at','2026-11-05T21:00:00+01:00',
    'article_id','79000000-0000-4000-8000-000000000001','images','[]'::jsonb,'links','[]'::jsonb,
    'people',jsonb_build_array('76100000-0000-4000-8000-000000000001'),'is_published',false,'expected_revision',NULL) || p_changes
$$;
GRANT EXECUTE ON FUNCTION pg_temp.article(jsonb),pg_temp.event(jsonb) TO anon,authenticated;
INSERT INTO app.help_contacts(id,display_name,discord,is_published) VALUES
 ('76100000-0000-4000-8000-000000000001','Published volunteer','published.volunteer',true),
 ('76100000-0000-4000-8000-000000000002','Unlisted volunteer',NULL,false);

SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
-- Images: the declared type must match the file signature, and a retry is the same image.
SELECT encode('\x524946460c00000057454250565038201234'::bytea,'base64') AS webp \gset
SELECT pg_temp.assert_true(public.amp_add_news_image('78000000-0000-4000-8000-000000000001','image/webp',:'webp',1600,900)='78000000-0000-4000-8000-000000000001','staff store an image');
SELECT pg_temp.assert_true(public.amp_add_news_image('78000000-0000-4000-8000-000000000001','image/webp',:'webp',1600,900)='78000000-0000-4000-8000-000000000001','an image retry converges');
SELECT pg_temp.expect_error(format('SELECT public.amp_add_news_image(%L,%L,%L,1600,901)','78000000-0000-4000-8000-000000000001','image/webp',:'webp'),'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');
SELECT pg_temp.expect_error(format('SELECT public.amp_add_news_image(%L,%L,%L,10,10)','78000000-0000-4000-8000-000000000002','image/jpeg',:'webp'),'INVALID_NEWS_IMAGE');
SELECT pg_temp.expect_error($q$SELECT public.amp_add_news_image('78000000-0000-4000-8000-000000000002','image/webp','not base64!',10,10)$q$,'INVALID_NEWS_IMAGE');
SELECT pg_temp.expect_error(format('SELECT public.amp_add_news_image(%L,%L,%L,0,10)','78000000-0000-4000-8000-000000000002','image/webp',:'webp'),'INVALID_NEWS_IMAGE');
SELECT pg_temp.expect_error($q$UPDATE public.amp_news_images SET width=1$q$,'permission denied');

-- An article and its event are created together in one command.
SELECT public.amp_save_news('7b000000-0000-4000-8000-000000000001',pg_temp.article(),pg_temp.event()) AS created \gset
SELECT pg_temp.assert_true((:'created'::jsonb)#>>'{article,edit_revision}'='1' AND (:'created'::jsonb)#>>'{event,slug}'='soldering-night','article and event are created together');
SELECT pg_temp.assert_true((SELECT article_id='79000000-0000-4000-8000-000000000001' AND starts_at='2026-11-05T17:00:00Z' FROM public.amp_events),'the event belongs to the article, at the instant sent');
SELECT pg_temp.assert_true((SELECT people='{76100000-0000-4000-8000-000000000002,76100000-0000-4000-8000-000000000001}' AND published_at IS NULL FROM public.amp_news_articles),'tags keep their order; a draft has no publication date');
SELECT count(*) AS audit_before_retry FROM public.amp_audit_log \gset
SELECT pg_temp.assert_true(public.amp_save_news('7b000000-0000-4000-8000-000000000001',pg_temp.article(),pg_temp.event())=:'created'::jsonb,'a lost-response retry returns the saved result');
SELECT pg_temp.assert_true((SELECT count(*)=:'audit_before_retry'::bigint FROM public.amp_audit_log),'a retry writes nothing');
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM public.amp_audit_log WHERE table_name IN ('news_articles','events') AND action='INSERT' AND actor_id='72000000-0000-4000-8000-000000000001'),'creation is audited with the staff actor');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news('7b000000-0000-4000-8000-000000000001',pg_temp.article('{"title":"Changed"}'),NULL)$q$,'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT');

-- Rejections.
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),NULL,NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","extra":1}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","title":5}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"Not a slug"}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","links":[{"label":"Bad","url":"javascript:alert(1)"}]}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","links":[{}]}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","images":[{}]}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","body":"a\u0007b"}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","people":["76100000-0000-4000-8000-000000000001","76100000-0000-4000-8000-000000000001"]}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","people":["76100000-0000-4000-8000-000000000099"]}'),NULL)$q$,'NEWS_PERSON_NOT_FOUND');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","slug":"x","images":[{"id":"78000000-0000-4000-8000-000000000099","alt":"Missing"}]}'),NULL)$q$,'NEWS_IMAGE_NOT_FOUND');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009"}'),NULL)$q$,'NEWS_SLUG_TAKEN');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article(),NULL)$q$,'STALE_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"expected_revision":"7"}'),NULL)$q$,'STALE_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"expected_revision":"1","slug":"renamed"}'),NULL)$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"id":"79000000-0000-4000-8000-000000000009","expected_revision":"1"}'),NULL)$q$,'NEWS_NOT_FOUND');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),NULL,pg_temp.event('{"id":"7a000000-0000-4000-8000-000000000009","slug":"other"}'))$q$,'EVENT_ARTICLE_TAKEN');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),NULL,pg_temp.event('{"id":"7a000000-0000-4000-8000-000000000009","slug":"other","article_id":"79000000-0000-4000-8000-000000000099"}'))$q$,'NEWS_NOT_FOUND');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"expected_revision":"1"}'),pg_temp.event('{"id":"7a000000-0000-4000-8000-000000000009","slug":"other","article_id":"79000000-0000-4000-8000-000000000099"}'))$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),NULL,pg_temp.event('{"id":"7a000000-0000-4000-8000-000000000009","slug":"other","article_id":null,"ends_at":"2026-11-05T17:00:00+01:00"}'))$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),NULL,pg_temp.event('{"id":"7a000000-0000-4000-8000-000000000009","slug":"other","article_id":null,"starts_at":"2026-11-05 18:00"}'))$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),NULL,pg_temp.event('{"id":"7a000000-0000-4000-8000-000000000009","slug":"other","article_id":null,"starts_at":"2026-13-45T18:00:00Z","ends_at":null}'))$q$,'INVALID_NEWS');
SELECT pg_temp.expect_error($q$INSERT INTO public.amp_news_articles(id,slug,title) VALUES(gen_random_uuid(),'direct','Direct')$q$,'permission denied');
SELECT pg_temp.expect_error($q$UPDATE public.amp_events SET is_published=true$q$,'permission denied');
SELECT pg_temp.expect_error($q$DELETE FROM public.amp_news_articles$q$,'permission denied');
RESET ROLE;
SELECT pg_temp.expect_error($q$DELETE FROM app.news_articles$q$,'IMMUTABLE_RECORD');
SELECT pg_temp.expect_error($q$DELETE FROM app.news_images$q$,'IMMUTABLE_RECORD');

-- Drafts stay private.
SET LOCAL ROLE anon;
SELECT pg_temp.assert_true(NOT EXISTS(SELECT FROM public.amp_news_feed()) AND public.amp_news_article('soldering-night') IS NULL
  AND public.amp_event('soldering-night') IS NULL AND NOT EXISTS(SELECT FROM public.amp_news_image('78000000-0000-4000-8000-000000000001')),'drafts and their images are not public');
SELECT pg_temp.expect_error('SELECT * FROM public.amp_news_articles','permission denied');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article(),NULL)$q$,'permission denied');
RESET ROLE;

-- Publishing the article alone shows it without its draft event.
SET LOCAL ROLE authenticated;
SELECT public.amp_save_news('7b000000-0000-4000-8000-000000000002',pg_temp.article('{"is_published":true,"expected_revision":"1"}'),NULL) AS published \gset
SELECT pg_temp.assert_true((:'published'::jsonb)#>>'{article,edit_revision}'='2' AND (:'published'::jsonb)->'event'='null','an edit advances the revision');
SELECT (SELECT published_at FROM public.amp_news_articles) AS first_published \gset
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(event IS NULL AND cover->>'alt'='Two people soldering' AND (cover->>'width')::integer=1600) FROM public.amp_news_feed()),'the feed shows the article, its cover and no draft event');
SELECT pg_temp.assert_true((SELECT jsonb_array_length(a->'people')=1 AND a#>>'{people,0,discord}'='published.volunteer' AND a->'event'='null' AND a#>>'{links,0,url}'='https://example.invalid/signup'
  FROM public.amp_news_article('soldering-night') a),'only published contacts are shown for tagged people');
SELECT pg_temp.assert_true((SELECT content_type='image/webp' AND decode(data,'base64')=decode(:'webp','base64') FROM public.amp_news_image('78000000-0000-4000-8000-000000000001')),'a published image is served');
SELECT pg_temp.assert_true((SELECT array_agg(key ORDER BY key)=ARRAY['cover','event','id','published_at','slug','summary','title'] FROM jsonb_object_keys((SELECT to_jsonb(f) FROM public.amp_news_feed() f LIMIT 1)) key),'the feed projection has only reviewed fields');
SELECT pg_temp.expect_error('SELECT * FROM public.amp_news_feed(NULL,NULL,0)','INVALID_NEWS_PAGE_SIZE');
SELECT pg_temp.expect_error($q$SELECT * FROM public.amp_news_feed(now(),NULL,10)$q$,'INVALID_NEWS_CURSOR');
RESET ROLE;

-- Publish the event; then unlink it, unpublish and republish the article.
SET LOCAL ROLE authenticated;
SELECT public.amp_save_news(gen_random_uuid(),NULL,pg_temp.event('{"is_published":true,"expected_revision":"1"}'));
RESET ROLE;
SET LOCAL ROLE anon;
SELECT pg_temp.assert_true((SELECT event->>'slug'='soldering-night' FROM public.amp_news_feed()),'the feed links the published event');
SELECT pg_temp.assert_true((SELECT e#>>'{article,slug}'='soldering-night' AND e->>'location'='PS126' FROM public.amp_event('soldering-night') e),'the event links its article');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.amp_event_calendar('2026-11-01T00:00:00+01:00','2026-12-01T00:00:00+01:00')),'the month contains the event');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.amp_event_calendar('2026-11-05T20:00:00+01:00','2026-11-06T00:00:00+01:00')),'an event still running overlaps the range');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.amp_event_calendar('2026-11-05T21:00:01+01:00','2026-11-06T00:00:00+01:00')),'a finished event is outside the range');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.amp_event_calendar('2026-11-01T00:00:00+01:00','2026-12-01T00:00:00+01:00','2026-11-05T17:00:00Z','7a000000-0000-4000-8000-000000000001')),'the cursor advances past the last event');
SELECT pg_temp.expect_error($q$SELECT * FROM public.amp_event_calendar('2026-11-01','2026-10-01')$q$,'INVALID_EVENT_RANGE');
SELECT pg_temp.expect_error($q$SELECT * FROM public.amp_event_calendar('2026-01-01','2027-03-01')$q$,'INVALID_EVENT_RANGE');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"is_published":false,"expected_revision":"2"}'),pg_temp.event('{"article_id":null,"expected_revision":"2"}'));
SELECT pg_temp.assert_true((SELECT article_id IS NULL FROM public.amp_events),'saving the event without its article unlinks it');
SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article('{"is_published":true,"expected_revision":"3"}'),NULL);
SELECT pg_temp.assert_true((SELECT published_at=:'first_published'::timestamptz FROM public.amp_news_articles),'republishing keeps the original date');
RESET ROLE;

-- An ordinary login is not staff.
SELECT set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000099","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true(NOT EXISTS(SELECT FROM public.amp_news_articles) AND NOT EXISTS(SELECT FROM public.amp_news_images),'ordinary login cannot read drafts or images');
SELECT pg_temp.expect_error($q$SELECT public.amp_save_news(gen_random_uuid(),pg_temp.article(),NULL)$q$,'STAFF_REQUIRED');
SELECT pg_temp.expect_error(format('SELECT public.amp_add_news_image(gen_random_uuid(),%L,%L,1,1)','image/webp',:'webp'),'STAFF_REQUIRED');
RESET ROLE;
ROLLBACK;
