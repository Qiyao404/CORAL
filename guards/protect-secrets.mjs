let d = '';
process.stdin.on('data', c => (d += c)).on('end', () => {
  const p = JSON.parse(d);
  if (String(p.toolInput?.path ?? '').match(/\.env$|secret|密码/i)) {
    process.stderr.write('该路径受外部守卫保护');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ decision: 'allow' }));
});
