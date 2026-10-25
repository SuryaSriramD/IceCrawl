-- Full-text index over stored page content. 'simple' keeps it language neutral; left() keeps a huge page under the tsvector size limit.
create index scrapes_fts_idx on scrapes using gin (to_tsvector('simple', left(coalesce(markdown, ''), 200000)));
