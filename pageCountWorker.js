const fs = require('fs');

// Usage: node pageCountWorker.js <filePath>
// Emits JSON to stdout: { count: N }
(async function(){
  const fp = process.argv[2];
  if (!fp) {
    console.error('No file path');
    process.exit(2);
  }
  let count = 0;
  try {
    const stream = fs.createReadStream(fp, { encoding: 'latin1' });
    let leftover = '';
    for await (const chunk of stream) {
      const data = leftover + chunk;
      // Count occurrences of '/Type /Page' (rough but fast)
      const matches = data.match(/\/Type\s*\/Page/g);
      if (matches) count += matches.length;
      // Keep last 40 chars in case pattern is split across chunks
      leftover = data.slice(-40);
    }
    // Write result to stdout
    process.stdout.write(JSON.stringify({ count }));
    process.exit(0);
  } catch (e) {
    // On error, return count 0
    process.stdout.write(JSON.stringify({ count: 0, error: String(e) }));
    process.exit(0);
  }
})();
