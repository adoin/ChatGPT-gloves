'use strict';

function entry(reference) {
  if (!/^[a-f0-9-]{36}$/.test(reference || '')) throw new Error('Invalid credential reference.');
  try {
    const { Entry } = require('@napi-rs/keyring');
    return new Entry('codex.local-ssh-deploy', reference, { linux: { store: 'secret-service' } });
  } catch { throw new Error('System credential storage is unavailable. Install the plugin dependencies and unlock your system credential store.'); }
}
function set(reference, password) {
  try { entry(reference).setPassword(password); }
  catch { throw new Error('Could not save the password to the system credential store.'); }
}
function get(reference) {
  try {
    const password = entry(reference).getPassword();
    if (password === null) throw new Error();
    return password;
  } catch { throw new Error('Saved password is unavailable. Edit the connection and save its password again.'); }
}
function remove(reference) {
  try { entry(reference).deleteCredential(); }
  catch { throw new Error('Could not remove the saved password from the system credential store.'); }
}
module.exports = { set, get, remove };
