console.log("ARGV=" + JSON.stringify(process.argv));
const [, cmd, ...rest] = process.argv;
console.log("CMD=" + JSON.stringify(cmd) + " REST=" + JSON.stringify(rest) + " eq=" + (cmd === "copy-gui"));
