-- Zurückgezogene Acts (von ShowTC gemeldet). Getrennt von `active`, damit in der Regie gelöschte
-- Acts beim Abgleich nicht wieder auftauchen.
alter table acts add column if not exists withdrawn boolean not null default false;

-- Jury-Zugang wurde nur wegen eines Rückzugs gesperrt; beim Rücknehmen wird genau dieser wieder frei.
alter table jurors add column if not exists withdrawn_disabled boolean not null default false;
