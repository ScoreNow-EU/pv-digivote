-- PINs zusätzlich im Klartext, damit die Regie sie sehen und exportieren kann.
-- Geprüft wird beim Login weiter über pin_hash. Bestehende PINs sind unbekannt (null),
-- bis sie in der Regie neu eingetragen werden; nur die Seed-PINs 1001-1010 werden erkannt.
alter table jurors add column pin text;

update jurors
set pin = seed.value::text
from generate_series(1001, 1010) as seed(value)
where jurors.pin is null
  and jurors.id::text like '00000000-0000-4000-8400-%'
  and jurors.pin_hash = crypt(seed.value::text, jurors.pin_hash);
