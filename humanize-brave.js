const path = require('path');
const fs = require('fs');
const { run } = require('./core');

const BRAVE_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'
);

if (!fs.existsSync(BRAVE_PATH)) {
  console.error(`Brave not found at ${BRAVE_PATH}. Edit BRAVE_PATH in humanize-brave.js if it's installed elsewhere.`);
  process.exit(1);
}

run({ executablePath: BRAVE_PATH }).catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
