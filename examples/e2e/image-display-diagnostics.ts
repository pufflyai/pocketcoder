const greetingProbe = `
import {createConnection} from 'node:net';
const socket=createConnection({host:'127.0.0.1',port:5900});
const timer=setTimeout(()=>socket.destroy(new Error('VNC greeting deadline')),5000);
socket.on('data',bytes=>{console.log('VNC_GREETING='+bytes.toString());clearTimeout(timer);socket.destroy()});
socket.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1});
`;

// Process files show whether the VNC server is waiting on a pipe, DNS, or the display.
// Environment and command lines can hold launch input, so this probe does not read them.
const processProbe = `
import {readdir,readFile,readlink} from 'node:fs/promises';
console.log(JSON.stringify({supervisorLimits:await readFile('/proc/1/limits','utf8')}));
for(const pid of await readdir('/proc')){
  if(!/^\\d+$/.test(pid))continue;
  const root='/proc/'+pid;
  const name=await readFile(root+'/comm','utf8').catch(()=> '');
  if(!['x11vnc','Xvfb','openbox','xterm'].includes(name.trim()))continue;
  const files={};
  for(const file of ['status','limits','wchan','schedstat','syscall'])
    files[file]=await readFile(root+'/'+file,'utf8').catch(error=>String(error));
  const descriptors={};
  for(const fd of await readdir(root+'/fd').catch(()=>[]))
    descriptors[fd]=await readlink(root+'/fd/'+fd).catch(error=>String(error));
  console.log(JSON.stringify({pid,name,files,descriptors}));
}
`;

export async function imageDisplayDiagnostics(
  kube: (args: string[]) => Promise<string>,
  namespace: string,
  workspaceId: string,
) {
  const pod = await kube([
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    `pocketcoder.workspace=${workspaceId}`,
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ]);
  const probes = await Promise.allSettled([
    kube(["-n", namespace, "logs", pod, "--all-containers", "--tail=200"]),
    kube(["-n", namespace, "logs", "deployment/controller", "--tail=200"]),
    kube(["-n", namespace, "exec", pod, "--", "bun", "-e", greetingProbe]),
    kube(["-n", namespace, "exec", pod, "--", "bun", "-e", processProbe]),
  ]);
  return probes.map((probe, index) => ({
    probe: ["workspace log", "controller log", "loopback VNC greeting", "display process state"][index],
    output: probe.status === "fulfilled" ? probe.value : String(probe.reason),
  }));
}
