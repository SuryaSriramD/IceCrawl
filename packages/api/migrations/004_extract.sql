alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check check (type in ('crawl', 'batch', 'extract'));
alter table jobs add column result jsonb;
alter table jobs add column tokens_used int;
