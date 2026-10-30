// zotero-next fork: runs one gulpfile.js task without gulp's own task runner. Gulp 4's async-done never sees the
// stream finish under Bun ("The following tasks did not complete"), so the stream the task returns is awaited here.
// usage: bun scripts/run-gulp-task.cjs <task> [gulpfile args...]
const [task, ...rest] = process.argv.slice(2);
process.argv = [process.argv[0], 'gulp', ...rest];
const gulp = require('gulp');
require('../gulpfile.js');
const stream = gulp.task(task).unwrap()();
if (!stream || typeof stream.on != 'function') process.exit(0);
stream.on('error', (e) => { console.error(e); process.exit(1); });
stream.on('end', () => process.exit(0));
stream.on('finish', () => setTimeout(() => process.exit(0), 200));
stream.resume();
