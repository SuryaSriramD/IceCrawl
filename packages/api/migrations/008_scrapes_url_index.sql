-- lets the index search find out whether a newer successful copy of a URL exists
create index scrapes_key_url_idx on scrapes (api_key_id, final_url, created_at desc);
