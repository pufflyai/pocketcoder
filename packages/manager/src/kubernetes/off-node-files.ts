export const offNodeSecret = "controller-off-node";
export const offNodeFileMount = { name: "off-node-config", mountPath: "/off-node-config", readOnly: true };
export const offNodeSecretVolume = {
  name: "off-node-config",
  secret: { secretName: offNodeSecret, defaultMode: 0o400 },
};
export const installOffNodeFiles =
  "await f.mkdir('/private/off-node',{recursive:true,mode:0o700});await f.chown('/private/off-node',0,0);await f.chmod('/private/off-node',0o700);for(const n of ['config.json','outer-key']){const t='/private/off-node/.'+n+'.tmp';await f.rm(t,{force:true});await f.copyFile('/off-node-config/'+n,t);await f.chmod(t,0o600);await f.chown(t,10001,10001);await f.rename(t,'/private/off-node/'+n)}await f.chown('/private/off-node',10001,10001)";
