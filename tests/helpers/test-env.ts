// Preloaded by `npm test`. A module's statements run on its own database login, whose password comes from the master key,
// so every test that touches a module needs one. It is the key the tests that set their own already use: the logins belong
// to the whole database cluster and test files run in parallel, so two keys would overwrite each other's passwords.
// A key set in the environment wins.
process.env.MODUNEXO_MASTER_KEY ??= "k".repeat(40);
