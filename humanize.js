const { run } = require('./core');

run({ channel: 'chrome' }).catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
