alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check check (type in ('crawl', 'batch', 'extract', 'agent'));
