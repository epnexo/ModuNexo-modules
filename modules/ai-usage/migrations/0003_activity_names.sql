-- Which tool a call used, which skill it loaded, and whether it failed. All three are optional: a log that does not
-- say leaves them null. Only short names are stored, never arguments, paths, text or output. Runs with search_path = ai_usage.
--
-- name:   the tool's name, for example Bash or read.
-- skill:  the skill a call loaded. Exact for Claude Code and OpenCode; inferred from a skills/<name>/SKILL.md path for
--         Codex and Pi, which have no skill event.
-- failed: true or false when the log reports the outcome of the call, null when it does not (Codex).
alter table activity_items
  add column name   text    check (name  is null or (char_length(name)  between 1 and 100 and name  !~ '[/\\\s]')),
  add column skill  text    check (skill is null or (char_length(skill) between 1 and 100 and skill !~ '[/\\\s]')),
  add column failed boolean;

create index activity_items_name_idx  on activity_items (tool_id, name)  where name  is not null;
create index activity_items_skill_idx on activity_items (tool_id, skill) where skill is not null;
