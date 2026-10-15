-- Newsroom and event calendar. Articles and events are separate rows, and an
-- event may belong to one article (events.article_id is unique). Staff write
-- both through amp_save_news, one atomic and retry-safe command, so an article
-- and its event are created, linked and unlinked together. Nothing is deleted:
-- unpublishing hides a row, and the audit log keeps every version.
--
-- Images live in the database, so the existing backups cover them. The browser
-- re-encodes an upload (dropping EXIF and GPS) before amp_add_news_image stores
-- it, and the public site serves only images a published row shows.

CREATE TABLE app.news_images (
  id uuid PRIMARY KEY,
  content_type text NOT NULL CHECK (content_type IN ('image/webp','image/jpeg','image/png')),
  data bytea NOT NULL CHECK (octet_length(data) >= 1 AND octet_length(data) <= 1048576),
  width integer NOT NULL CHECK (width >= 1 AND width <= 4096),
  height integer NOT NULL CHECK (height >= 1 AND height <= 4096),
  created_by uuid NOT NULL REFERENCES app.staff_members(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Up to 8 images as [{"id":"<uuid>","alt":"..."}]; the first is the cover.
CREATE FUNCTION app.news_images_valid(p_images jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN jsonb_typeof(p_images) IS DISTINCT FROM 'array' THEN false WHEN jsonb_array_length(p_images) > 8 THEN false
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_images) i(value) WHERE jsonb_typeof(i.value) <> 'object') THEN false
    ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_images) i(value)
        WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(i.value) k) IS DISTINCT FROM ARRAY['alt','id']
          OR coalesce(jsonb_typeof(i.value->'id') <> 'string'
            OR i.value->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR jsonb_typeof(i.value->'alt') <> 'string'
            OR length(btrim(i.value->>'alt')) < 1 OR length(i.value->>'alt') > 300
            OR i.value->>'alt' ~ '[[:cntrl:]]',true))
      AND (SELECT count(DISTINCT i.value->>'id') FROM jsonb_array_elements(p_images) i(value)) = jsonb_array_length(p_images) END
$$;
-- Up to 10 labelled links as [{"label":"...","url":"https://..."}], with the
-- same URL rules as help_contacts.contact_url.
CREATE FUNCTION app.news_links_valid(p_links jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN jsonb_typeof(p_links) IS DISTINCT FROM 'array' THEN false WHEN jsonb_array_length(p_links) > 10 THEN false
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p_links) l(value) WHERE jsonb_typeof(l.value) <> 'object') THEN false
    ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_links) l(value)
        WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(l.value) k) IS DISTINCT FROM ARRAY['label','url']
          OR coalesce(jsonb_typeof(l.value->'label') <> 'string' OR jsonb_typeof(l.value->'url') <> 'string'
            OR length(btrim(l.value->>'label')) < 1 OR length(l.value->>'label') > 80
            OR l.value->>'label' ~ '[[:cntrl:]]'
            OR length(l.value->>'url') > 500 OR l.value->>'url' ~ '[[:cntrl:]]'
            OR l.value->>'url' !~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]\\]*)?$'
            OR coalesce(substring(l.value->>'url' FROM '^https://[^/:?#]+:([0-9]+)')::integer,443) > 65535,true)) END
$$;
REVOKE ALL ON FUNCTION app.news_images_valid(jsonb),app.news_links_valid(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Slugs are the public addresses (/news/<slug>, /events/<slug>). They are
-- chosen once from the title and never change, so shared links keep working.
CREATE TABLE app.news_articles (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  title text NOT NULL CHECK (length(btrim(title)) >= 1 AND length(title) <= 160 AND title !~ '[[:cntrl:]]'),
  summary text CHECK (summary IS NULL OR (length(btrim(summary)) >= 1 AND length(summary) <= 300 AND summary !~ '[[:cntrl:]]')),
  -- Plain text; a blank line starts a new paragraph.
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 20000 AND translate(body,E'\n\r\t','') !~ '[[:cntrl:]]'),
  images jsonb NOT NULL DEFAULT '[]' CHECK (app.news_images_valid(images)),
  links jsonb NOT NULL DEFAULT '[]' CHECK (app.news_links_valid(links)),
  -- Tagged volunteers (help_contacts), in display order. Public pages show only published contacts.
  people uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(people) <= 20 AND array_position(people,NULL) IS NULL),
  is_published boolean NOT NULL DEFAULT false,
  -- Set on first publication and kept, so republishing keeps the original date.
  published_at timestamptz,
  edit_revision bigint NOT NULL DEFAULT 1 CHECK (edit_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT is_published OR published_at IS NOT NULL)
);
CREATE INDEX news_articles_published_idx ON app.news_articles(published_at DESC,id DESC) WHERE is_published;

CREATE TABLE app.events (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 80),
  title text NOT NULL CHECK (length(btrim(title)) >= 1 AND length(title) <= 160 AND title !~ '[[:cntrl:]]'),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 5000 AND translate(description,E'\n\r\t','') !~ '[[:cntrl:]]'),
  location text CHECK (location IS NULL OR (length(btrim(location)) >= 1 AND length(location) <= 160 AND location !~ '[[:cntrl:]]')),
  starts_at timestamptz NOT NULL,
  -- Optional; an event lasts at most 62 days so a month view stays readable.
  ends_at timestamptz CHECK (ends_at IS NULL OR (ends_at > starts_at AND ends_at <= starts_at + interval '62 days')),
  article_id uuid UNIQUE REFERENCES app.news_articles(id),
  images jsonb NOT NULL DEFAULT '[]' CHECK (app.news_images_valid(images)),
  links jsonb NOT NULL DEFAULT '[]' CHECK (app.news_links_valid(links)),
  people uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(people) <= 20 AND array_position(people,NULL) IS NULL),
  is_published boolean NOT NULL DEFAULT false,
  edit_revision bigint NOT NULL DEFAULT 1 CHECK (edit_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_published_start_idx ON app.events(starts_at,id) WHERE is_published;

-- Same protections as the other master data: staff read, writes only through
-- the RPCs below, every change audited, rows never deleted. Images never change.
ALTER TABLE app.news_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.news_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_read ON app.news_images FOR SELECT TO authenticated USING ((SELECT app.is_staff()));
CREATE POLICY staff_read ON app.news_articles FOR SELECT TO authenticated USING ((SELECT app.is_staff()));
CREATE POLICY staff_read ON app.events FOR SELECT TO authenticated USING ((SELECT app.is_staff()));
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON app.news_images FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app.news_images FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER audit_metadata AFTER INSERT OR UPDATE OR DELETE ON app.news_articles FOR EACH ROW EXECUTE FUNCTION app.audit_metadata();
CREATE TRIGGER audit_metadata AFTER INSERT OR UPDATE OR DELETE ON app.events FOR EACH ROW EXECUTE FUNCTION app.audit_metadata();
CREATE TRIGGER keep_records BEFORE DELETE ON app.news_articles FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER keep_records BEFORE DELETE ON app.events FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
REVOKE ALL ON app.news_images,app.news_articles,app.events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app.news_images,app.news_articles,app.events TO authenticated;
CREATE VIEW public.amp_news_images WITH (security_invoker=true) AS SELECT * FROM app.news_images;
CREATE VIEW public.amp_news_articles WITH (security_invoker=true) AS SELECT * FROM app.news_articles;
CREATE VIEW public.amp_events WITH (security_invoker=true) AS SELECT * FROM app.events;
REVOKE ALL ON public.amp_news_images,public.amp_news_articles,public.amp_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.amp_news_images,public.amp_news_articles,public.amp_events TO authenticated;

-- ---------- Staff writes ----------

-- p_data is base64. A retry with the same id and bytes returns the same id.
CREATE FUNCTION public.amp_add_news_image(p_id uuid,p_content_type text,p_data text,p_width integer,p_height integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_actor uuid := app.require_staff(); v_data bytea; v_row app.news_images%ROWTYPE;
BEGIN
  PERFORM app.require_read_committed();
  IF p_id IS NULL THEN RAISE EXCEPTION 'REQUEST_ID_REQUIRED'; END IF;
  BEGIN v_data := decode(p_data,'base64');
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'INVALID_NEWS_IMAGE'; END;
  -- The declared type must match the file's signature, so the site can serve it as declared.
  IF v_data IS NULL OR octet_length(v_data) < 1 OR octet_length(v_data) > 1048576
     OR p_width IS NULL OR p_width < 1 OR p_width > 4096 OR p_height IS NULL OR p_height < 1 OR p_height > 4096
     OR NOT coalesce((p_content_type='image/webp' AND substring(v_data FROM 1 FOR 4)='\x52494646'::bytea AND substring(v_data FROM 9 FOR 4)='\x57454250'::bytea)
       OR (p_content_type='image/jpeg' AND substring(v_data FROM 1 FOR 3)='\xffd8ff'::bytea)
       OR (p_content_type='image/png' AND substring(v_data FROM 1 FOR 8)='\x89504e470d0a1a0a'::bytea),false) THEN
    RAISE EXCEPTION 'INVALID_NEWS_IMAGE';
  END IF;
  INSERT INTO app.news_images(id,content_type,data,width,height,created_by)
    VALUES(p_id,p_content_type,v_data,p_width,p_height,v_actor) ON CONFLICT (id) DO NOTHING;
  SELECT * INTO STRICT v_row FROM app.news_images WHERE id=p_id;
  IF (v_row.content_type,v_row.data,v_row.width,v_row.height) IS DISTINCT FROM (p_content_type,v_data,p_width,p_height) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT';
  END IF;
  RETURN p_id;
END $$;

-- Rejects anything but exactly these keys, so a misspelt field is never ignored.
CREATE FUNCTION app.news_require_keys(p_value jsonb,p_keys text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_value) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(p_keys) k) THEN
    RAISE EXCEPTION 'INVALID_NEWS';
  END IF;
END $$;
-- A JSON string or null; numbers and booleans are not silently converted.
CREATE FUNCTION app.news_text(p_value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value)='null' THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_value) <> 'string' THEN RAISE EXCEPTION 'INVALID_NEWS'; END IF;
  RETURN p_value #>> '{}';
END $$;
-- Shared by articles and events: tagged contacts and images must exist.
CREATE FUNCTION app.news_check_references(p_images jsonb,p_people jsonb) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_people uuid[];
BEGIN
  IF NOT app.news_images_valid(p_images) OR jsonb_typeof(p_people) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_NEWS'; END IF;
  IF jsonb_array_length(p_people) > 20
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_people) p(value) WHERE jsonb_typeof(p.value) <> 'string'
       OR p.value #>> '{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'INVALID_NEWS';
  END IF;
  v_people := ARRAY(SELECT (p.value #>> '{}')::uuid FROM jsonb_array_elements(p_people) WITH ORDINALITY p(value,n) ORDER BY p.n);
  IF cardinality(v_people) <> (SELECT count(DISTINCT x) FROM unnest(v_people) x) THEN RAISE EXCEPTION 'INVALID_NEWS'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_people) x WHERE NOT EXISTS (SELECT 1 FROM app.help_contacts c WHERE c.id=x)) THEN
    RAISE EXCEPTION 'NEWS_PERSON_NOT_FOUND';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_images) i(value)
             WHERE NOT EXISTS (SELECT 1 FROM app.news_images m WHERE m.id=(i.value->>'id')::uuid)) THEN
    RAISE EXCEPTION 'NEWS_IMAGE_NOT_FOUND';
  END IF;
  RETURN v_people;
END $$;
REVOKE ALL ON FUNCTION app.news_require_keys(jsonb,text[]),app.news_text(jsonb),app.news_check_references(jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

-- p_article and p_event are each null (left untouched) or the complete row:
--   article: id, slug, title, summary, body, images, links, people, is_published, expected_revision
--   event:   id, slug, title, description, location, starts_at, ends_at, article_id,
--            images, links, people, is_published, expected_revision
-- expected_revision is null to create the row, otherwise the edit_revision the
-- editor read. The event owns the link: article_id null unlinks it. Returns
-- {"article":{"id","slug","edit_revision"}|null,"event":{...}|null}.
CREATE FUNCTION public.amp_save_news(p_request_id uuid,p_article jsonb,p_event jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := app.require_staff(); v_cached jsonb; v_constraint text;
  v_id uuid; v_revision bigint; v_people uuid[]; v_published boolean; v_link uuid;
  v_starts timestamptz; v_ends timestamptz;
  v_article app.news_articles%ROWTYPE; v_event app.events%ROWTYPE;
  v_result jsonb := jsonb_build_object('article',NULL,'event',NULL);
BEGIN
  v_cached := app.begin_command(p_request_id,'save_news',v_actor,jsonb_build_object('article',p_article,'event',p_event));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;
  IF (p_article IS NULL OR jsonb_typeof(p_article)='null') AND (p_event IS NULL OR jsonb_typeof(p_event)='null') THEN
    RAISE EXCEPTION 'INVALID_NEWS';
  END IF;

  BEGIN
    IF p_article IS NOT NULL AND jsonb_typeof(p_article) <> 'null' THEN
      PERFORM app.news_require_keys(p_article,ARRAY['id','slug','title','summary','body','images','links','people','is_published','expected_revision']);
      IF jsonb_typeof(p_article->'is_published') <> 'boolean' OR app.news_text(p_article->'id') IS NULL
         OR app.news_text(p_article->'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR coalesce(app.news_text(p_article->'expected_revision'),'1') !~ '^[1-9][0-9]{0,17}$' THEN
        RAISE EXCEPTION 'INVALID_NEWS';
      END IF;
      v_id := app.news_text(p_article->'id')::uuid; v_revision := app.news_text(p_article->'expected_revision')::bigint;
      v_people := app.news_check_references(p_article->'images',p_article->'people');
      v_published := (p_article->'is_published')::boolean;
      IF v_revision IS NULL THEN
        IF EXISTS (SELECT 1 FROM app.news_articles WHERE id=v_id) THEN RAISE EXCEPTION 'STALE_NEWS'; END IF;
        INSERT INTO app.news_articles(id,slug,title,summary,body,images,links,people,is_published,published_at)
          VALUES(v_id,app.news_text(p_article->'slug'),app.news_text(p_article->'title'),app.news_text(p_article->'summary'),
            coalesce(app.news_text(p_article->'body'),''),p_article->'images',p_article->'links',v_people,v_published,
            CASE WHEN v_published THEN clock_timestamp() END)
          RETURNING * INTO v_article;
      ELSE
        SELECT * INTO v_article FROM app.news_articles WHERE id=v_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'NEWS_NOT_FOUND'; END IF;
        IF v_article.edit_revision <> v_revision THEN RAISE EXCEPTION 'STALE_NEWS'; END IF;
        IF v_article.slug IS DISTINCT FROM app.news_text(p_article->'slug') THEN RAISE EXCEPTION 'INVALID_NEWS'; END IF;
        UPDATE app.news_articles SET title=app.news_text(p_article->'title'),summary=app.news_text(p_article->'summary'),
            body=coalesce(app.news_text(p_article->'body'),''),images=p_article->'images',links=p_article->'links',people=v_people,
            is_published=v_published,published_at=coalesce(published_at,CASE WHEN v_published THEN clock_timestamp() END),
            edit_revision=edit_revision+1,updated_at=clock_timestamp()
          WHERE id=v_id RETURNING * INTO v_article;
      END IF;
      v_result := jsonb_set(v_result,'{article}',jsonb_build_object('id',v_article.id,'slug',v_article.slug,'edit_revision',v_article.edit_revision::text));
    END IF;

    IF p_event IS NOT NULL AND jsonb_typeof(p_event) <> 'null' THEN
      PERFORM app.news_require_keys(p_event,ARRAY['id','slug','title','description','location','starts_at','ends_at','article_id','images','links','people','is_published','expected_revision']);
      IF jsonb_typeof(p_event->'is_published') <> 'boolean' OR app.news_text(p_event->'id') IS NULL
         OR app.news_text(p_event->'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR coalesce(app.news_text(p_event->'article_id'),'00000000-0000-0000-0000-000000000000') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR coalesce(app.news_text(p_event->'expected_revision'),'1') !~ '^[1-9][0-9]{0,17}$'
         -- Instants carry an explicit offset; the editor converts Oslo wall time.
         OR app.news_text(p_event->'starts_at') IS NULL
         OR app.news_text(p_event->'starts_at') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,6})?)?(Z|[+-]\d\d:\d\d)$'
         OR coalesce(app.news_text(p_event->'ends_at'),'2000-01-01T00:00Z') !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,6})?)?(Z|[+-]\d\d:\d\d)$' THEN
        RAISE EXCEPTION 'INVALID_NEWS';
      END IF;
      v_id := app.news_text(p_event->'id')::uuid; v_revision := app.news_text(p_event->'expected_revision')::bigint;
      v_link := app.news_text(p_event->'article_id')::uuid;
      v_starts := app.news_text(p_event->'starts_at')::timestamptz; v_ends := app.news_text(p_event->'ends_at')::timestamptz;
      v_people := app.news_check_references(p_event->'images',p_event->'people');
      v_published := (p_event->'is_published')::boolean;
      -- Saved together, the event can only belong to the article beside it.
      IF v_link IS NOT NULL AND v_article.id IS NOT NULL AND v_link <> v_article.id THEN RAISE EXCEPTION 'INVALID_NEWS'; END IF;
      IF v_link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.news_articles WHERE id=v_link) THEN RAISE EXCEPTION 'NEWS_NOT_FOUND'; END IF;
      IF v_revision IS NULL THEN
        IF EXISTS (SELECT 1 FROM app.events WHERE id=v_id) THEN RAISE EXCEPTION 'STALE_NEWS'; END IF;
        INSERT INTO app.events(id,slug,title,description,location,starts_at,ends_at,article_id,images,links,people,is_published)
          VALUES(v_id,app.news_text(p_event->'slug'),app.news_text(p_event->'title'),coalesce(app.news_text(p_event->'description'),''),
            app.news_text(p_event->'location'),v_starts,v_ends,v_link,p_event->'images',p_event->'links',v_people,v_published)
          RETURNING * INTO v_event;
      ELSE
        SELECT * INTO v_event FROM app.events WHERE id=v_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'NEWS_NOT_FOUND'; END IF;
        IF v_event.edit_revision <> v_revision THEN RAISE EXCEPTION 'STALE_NEWS'; END IF;
        IF v_event.slug IS DISTINCT FROM app.news_text(p_event->'slug') THEN RAISE EXCEPTION 'INVALID_NEWS'; END IF;
        UPDATE app.events SET title=app.news_text(p_event->'title'),description=coalesce(app.news_text(p_event->'description'),''),
            location=app.news_text(p_event->'location'),starts_at=v_starts,ends_at=v_ends,article_id=v_link,
            images=p_event->'images',links=p_event->'links',people=v_people,is_published=v_published,
            edit_revision=edit_revision+1,updated_at=clock_timestamp()
          WHERE id=v_id RETURNING * INTO v_event;
      END IF;
      v_result := jsonb_set(v_result,'{event}',jsonb_build_object('id',v_event.id,'slug',v_event.slug,'edit_revision',v_event.edit_revision::text));
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IN ('news_articles_slug_key','events_slug_key') THEN RAISE EXCEPTION 'NEWS_SLUG_TAKEN'; END IF;
      IF v_constraint='events_article_id_key' THEN RAISE EXCEPTION 'EVENT_ARTICLE_TAKEN'; END IF;
      RAISE;
    -- Out-of-range text, bad slugs and impossible times are form errors, not bugs.
    WHEN check_violation OR not_null_violation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'INVALID_NEWS';
  END;
  RETURN app.finish_command(p_request_id,v_result);
END $$;

-- ---------- Public reads ----------

-- Published contacts only, in tag order, with the /contact details.
CREATE FUNCTION app.news_people(p_people uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'display_name',c.display_name,'responsibility',c.responsibility,
      'email',c.email,'phone',c.phone,'contact_url',c.contact_url,'discord',c.discord) ORDER BY o.n),'[]'::jsonb)
  FROM unnest(p_people) WITH ORDINALITY o(id,n) JOIN app.help_contacts c ON c.id=o.id AND c.is_published
$$;
-- Image size travels with the reference, so pages reserve the space before it loads.
CREATE FUNCTION app.news_image_cards(p_images jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'alt',i.value->>'alt','width',m.width,'height',m.height) ORDER BY i.n),'[]'::jsonb)
  FROM jsonb_array_elements(p_images) WITH ORDINALITY i(value,n) JOIN app.news_images m ON m.id=(i.value->>'id')::uuid
$$;
REVOKE ALL ON FUNCTION app.news_people(uuid[]),app.news_image_cards(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Newest first, by (published_at, id). Send both cursor fields or neither.
CREATE FUNCTION public.amp_news_feed(p_before_published timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid,slug text,title text,summary text,published_at timestamptz,cover jsonb,event jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'INVALID_NEWS_PAGE_SIZE'; END IF;
  IF (p_before_published IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'INVALID_NEWS_CURSOR'; END IF;
  RETURN QUERY SELECT a.id,a.slug,a.title,a.summary,a.published_at,app.news_image_cards(a.images)->0,
      (SELECT jsonb_build_object('slug',e.slug,'title',e.title,'starts_at',e.starts_at,'ends_at',e.ends_at,'location',e.location)
         FROM app.events e WHERE e.article_id=a.id AND e.is_published)
    FROM app.news_articles a WHERE a.is_published
      AND (p_before_published IS NULL OR (a.published_at,a.id) < (p_before_published,p_before_id))
    ORDER BY a.published_at DESC,a.id DESC LIMIT p_limit;
END $$;

-- One published article, or null.
CREATE FUNCTION public.amp_news_article(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id',a.id,'slug',a.slug,'title',a.title,'summary',a.summary,'body',a.body,
      'published_at',a.published_at,'images',app.news_image_cards(a.images),'links',a.links,'people',app.news_people(a.people),
      'event',(SELECT jsonb_build_object('slug',e.slug,'title',e.title,'starts_at',e.starts_at,'ends_at',e.ends_at,'location',e.location)
         FROM app.events e WHERE e.article_id=a.id AND e.is_published))
  FROM app.news_articles a WHERE a.slug=p_slug AND a.is_published
$$;

-- Published events overlapping [p_from, p_to), by (starts_at, id). The range
-- is at most 400 days; page until empty with both cursor fields.
CREATE FUNCTION public.amp_event_calendar(p_from timestamptz,p_to timestamptz,
  p_after_start timestamptz DEFAULT NULL,p_after_id uuid DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid,slug text,title text,location text,starts_at timestamptz,ends_at timestamptz,cover jsonb,article jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN RAISE EXCEPTION 'INVALID_NEWS_PAGE_SIZE'; END IF;
  IF (p_after_start IS NULL) <> (p_after_id IS NULL) THEN RAISE EXCEPTION 'INVALID_NEWS_CURSOR'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to > p_from + interval '400 days' THEN
    RAISE EXCEPTION 'INVALID_EVENT_RANGE';
  END IF;
  RETURN QUERY SELECT e.id,e.slug,e.title,e.location,e.starts_at,e.ends_at,app.news_image_cards(e.images)->0,
      (SELECT jsonb_build_object('slug',a.slug,'title',a.title) FROM app.news_articles a WHERE a.id=e.article_id AND a.is_published)
    FROM app.events e WHERE e.is_published
      AND e.starts_at < p_to AND coalesce(e.ends_at,e.starts_at) >= p_from
      AND (p_after_start IS NULL OR (e.starts_at,e.id) > (p_after_start,p_after_id))
    ORDER BY e.starts_at,e.id LIMIT p_limit;
END $$;

-- One published event, or null.
CREATE FUNCTION public.amp_event(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id',e.id,'slug',e.slug,'title',e.title,'description',e.description,'location',e.location,
      'starts_at',e.starts_at,'ends_at',e.ends_at,'images',app.news_image_cards(e.images),'links',e.links,'people',app.news_people(e.people),
      'article',(SELECT jsonb_build_object('slug',a.slug,'title',a.title,'summary',a.summary) FROM app.news_articles a WHERE a.id=e.article_id AND a.is_published))
  FROM app.events e WHERE e.slug=p_slug AND e.is_published
$$;

-- An image as base64, only while a published article or event shows it.
CREATE FUNCTION public.amp_news_image(p_id uuid) RETURNS TABLE (content_type text,data text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT m.content_type,translate(encode(m.data,'base64'),E'\n','') FROM app.news_images m WHERE m.id=p_id
    AND (EXISTS (SELECT 1 FROM app.news_articles a WHERE a.is_published AND a.images @> jsonb_build_array(jsonb_build_object('id',p_id::text)))
      OR EXISTS (SELECT 1 FROM app.events e WHERE e.is_published AND e.images @> jsonb_build_array(jsonb_build_object('id',p_id::text))))
$$;

REVOKE ALL ON FUNCTION public.amp_add_news_image(uuid,text,text,integer,integer),public.amp_save_news(uuid,jsonb,jsonb),
  public.amp_news_feed(timestamptz,uuid,integer),public.amp_news_article(text),
  public.amp_event_calendar(timestamptz,timestamptz,timestamptz,uuid,integer),public.amp_event(text),public.amp_news_image(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amp_add_news_image(uuid,text,text,integer,integer),public.amp_save_news(uuid,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.amp_news_feed(timestamptz,uuid,integer),public.amp_news_article(text),
  public.amp_event_calendar(timestamptz,timestamptz,timestamptz,uuid,integer),public.amp_event(text),public.amp_news_image(uuid)
  TO anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
