# `/news` and `/events`: newsroom and event calendar

Public pages in `src/routes/[[locale=locale]]/news/` and `events/`, the staff editor in
`admin/news/`. Copy lives in `src/lib/i18n/{nb,en}.ts` under `news`, `events` and
`adminNews`; the read protocol is in [api-contract.md](api-contract.md#news-and-events)
and the tables in [datamodell.md](datamodell.md#newsroom-and-event-calendar).

## 1. Job of the pages

Tell members what is coming up and what has happened in the workshop. An article and
an event are separate things that often belong together: a course has a time and place
in the calendar and a story with photos and the volunteers running it. Either can
exist alone. Content is written once, in the author's language; only the interface is
translated ([i18n.md](i18n.md#6-what-is-not-translated)).

Hard constraints:

- **Only published rows are public**, and an image is served only while a published
  article or event shows it. A failed read says unavailable with a retry, never
  "no news".
- **The homepage reads nothing.** It links here from the hero with a secondary
  button beside the catalog («Hva skjer»), not a live "next event", because the homepage renders without a database read
  ([page-home.md](page-home.md#1-job-of-the-page)).
- **Times are Oslo wall time** at every width and in every browser time zone.
- **Images reserve their box** from the stored width and height, so nothing shifts.
- **Tagged people** are published volunteers from `/contact`. A name opens their
  contact details in a popover; without JavaScript it links to the same person on
  `/contact`.

## 2. `/news`

Phone first: «Kommende arrangementer» with the next three events that
have not ended, the calendar link, then «Nyheter». Both are flat lists with one
separator between rows (`Item`), no cards. An event row has a borderless date mark
(month over day), the title, the weekday and hours (the full date for screen readers)
and the place. An article row has its cover, date, title, summary and, when linked, the
event time; from 48rem the cover sits beside the text. Each row's title link covers the
row. From 64rem the articles take the main column and the events a 23rem column beside
them. Twelve articles per page; «Eldre nyheter» continues from the last one shown
(`?before=<published_at>&id=<id>`, not indexed). The page's h1 («Nyheter og
arrangementer») is visually hidden: the two section headings already name the page.

`/news/[slug]` shows the title, summary, byline («Av …», when set) and publish date and
time (Oslo), the cover, a bordered box with the linked event, the body (a blank line
starts a paragraph; an image placed in the text shows there at the article's width),
the images not placed in the text, then «Folk» and «Lenker» sections when they have
entries. The cover opens the article unless it is placed in the text. Article rows on
`/news` show the publish date and time and the author.

## 3. `/events`

A month grid (`?month=YYYY-MM`, default the current Oslo month) of whole Monday-first
weeks, then that month's events listed by day. On phones a day with events shows its
number as a link and up to three dots; from 48rem up to two titles show in the cell.
The day link jumps to that day's list. Today has an outline and a hidden «i dag». An
event spanning several days appears under each day. Previous and next are icon links
with names; «Denne måneden» returns to the current month.

`/events/[slug]` shows the title, when and where, the cover, the description, the
linked article as a box with a link, the remaining images, people and links.

## 4. Admin

`/admin/news` («Nettsiden» in the sidebar) lists every article and event, an article
and its event as one entry with a published or unpublished badge each, latest change
first. «Ny artikkel» and «Nytt arrangement» open the editor.

`/admin/news/[id]` (an article or event id, or `new?with=article|event`) is one form:

- **Artikkel** and **Arrangement** sections. A missing side offers «Legg til …» or a
  select of existing rows that have no link yet. With both sides present, «Fjern …»
  takes one out; a side that is linked in the database is then saved back unlinked,
  never deleted, and «Angre» restores it until saving.
- **Forfatter** is the byline, filled with the signed-in admin's name for a new
  article; it can be changed or cleared.
- **Images in the text** (`ArticleBodyEditor`, logic in `article-body.ts`). The text
  is one bordered field of text parts with a thumbnail row for each placed image.
  «Sett inn bilde» under it uploads an image and places it where the cursor was;
  «Sett inn i teksten» on an image in the list places that one. An image goes before
  the line the cursor starts or after the line it is in, never inside a line. Drag a
  thumbnail to move it: a line shows where it will land, between any two written lines
  or images, and Escape cancels. The page is never scrolled for you; scroll with the
  wheel while dragging. The arrow buttons move it one place at a time (the keyboard and
  touch alternative) and ✕ takes it out of the text, keeping it in the list. An image
  stands between paragraphs, so the line it split stays two paragraphs when it leaves.
  Stored, each placed image is a paragraph `[image:<id>]`.
- **Bilder, Lenker, Personer** apply to both sides. The browser re-encodes each
  image (at most 1600 px and 1 MB, no EXIF) and uploads it once with a fixed id; a
  failed upload retries the same id. Every image needs a description for screen
  readers; the first is the cover. People are checked from the contact list, in its
  order; unpublished contacts are marked «Ikke på kontaktsiden».
- **Lagre** persists the exact command in `sessionStorage` before sending. An
  uncertain result keeps it and the button becomes «Lagre igjen», which resends the
  same request. A reload with an unfinished command says so and offers «Fullfør
  endringen». A stale revision asks to load the new version; nothing is overwritten.

Slugs come from the title on first save (æ, ø and å spelt out, a number added when
taken) and never change, so shared links keep working.
