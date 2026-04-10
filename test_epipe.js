const { spawn } = require('child_process');
const proc = spawn('false'); // exits immediately
setTimeout(() => {
  try {
    proc.stdin.write('hello\n');
    console.log('write completed without sync throw');
  } catch (e) {
    console.log('caught sync:', e.message);
  }
}, 500);
