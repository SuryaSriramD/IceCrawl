import { main } from './main';

main(process.argv.slice(2), process.env).catch((err) => {
  console.error(`icecrawl-mcp failed to start: ${err.message}`);
  process.exit(1);
});
