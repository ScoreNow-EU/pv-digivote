alter table acts add column real_song_title text;
update acts set real_song_title = song_title where real_song_title is null;
alter table acts alter column real_song_title set not null;
