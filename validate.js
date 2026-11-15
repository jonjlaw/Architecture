#!/usr/bin/env node
/* Checks a Faultline system file before it is imported.
   Usage: node validate.js <map.json> [path/to/index.html]
   Exit code 0 = no errors (warnings may remain), 1 = errors. */
const fs=require('fs'),path=require('path');
const file=process.argv[2],htmlPath=process.argv[3]||path.join(__dirname,'index.html');
if(!file){console.error('usage: node validate.js <map.json> [index.html]');process.exit(2)}
const html=fs.readFileSync(htmlPath,'utf8');
const grab=id=>html.split('<script id="'+id+'">')[1].split('</script>')[0];
const E=new Function(grab('engine').replace(/if\(typeof module[^\n]*/,'')+
 '\nreturn {Sim,KIND,TYPES,KDEF,FDEF,EFDEF,GFDEF,CFDEF,SFDEF,RFDEF,SUBD,POLLD,ACTD,GDEF,SGDEF,NODE_W,NODE_H,AFLAGS,canConnect,tableOf,normalize,tyParse};')();
let raw;try{raw=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){console.error('ERROR  not valid JSON: '+e.message);process.exit(1)}
const errs=[],warns=[],err=s=>errs.push(s),warn=s=>warns.push(s);
const m=raw;
if(!m||!Array.isArray(m.nodes)){console.error('ERROR  top level needs a "nodes" array');process.exit(1)}
m.edges=m.edges||[];m.groups=m.groups||[];m.scenarios=m.scenarios||[];

/* ids */
const seen=new Map(),idOk=(id,pre,what)=>{if(typeof id!=='string'||!new RegExp('^'+pre+'\\d+$').test(id))err(what+': id "'+id+'" must be "'+pre+'" followed by a number');else if(seen.has(id))err(what+': id "'+id+'" is already used by '+seen.get(id));else seen.set(id,what)};
const nodes=new Map();
for(const n of m.nodes){const what='node "'+(n.name||n.id)+'"';idOk(n.id,'n',what);
 if(!E.TYPES[n.type]){err(what+': unknown type "'+n.type+'" (it would be dropped on import)');continue}
 if(typeof n.x!=='number'||typeof n.y!=='number')err(what+': needs numeric x and y');
 if(!n.name)warn(what+': has no name');
 nodes.set(n.id,n);
 const k=E.KIND(n),known=Object.assign({},E.KDEF[k],E.TYPES[n.type].d||{});
 for(const key in n.cfg||{})if(!(key in known))warn(what+': cfg.'+key+' is not a setting of a '+k+' and will be ignored');
 for(const key in n.fault||{})if(!(key in E.FDEF[k]))warn(what+': fault.'+key+' is not a fault of a '+k);
 if(n.cfg&&n.cfg.actions&&k!=='service')err(what+': only service-kind nodes have actions');
 if(n.cfg&&n.cfg.tables){if(k!=='store')err(what+': only databases have tables');else for(const t of n.cfg.tables){idOk(t.id,'t',what+' table "'+t.name+'"');if(!['queue','dedupe','data'].includes(t.kind))err(what+' table "'+t.name+'": kind must be queue, dedupe or data')}}}
const nm=id=>nodes.has(id)?nodes.get(id).name:id;
/* type lists: "Name", "Name@2", "Name:70", "Name@2:70", separated by commas */
const tyOk=(str,what)=>{for(const tok of String(str||'').split(/[,;\n]+/))if(tok.trim()&&!/^\s*([^\s@:]+)\s*(?:@\s*(\d+))?\s*(?::\s*([\d.]+))?\s*$/.test(tok))warn(what+': "'+tok.trim()+'" is not a valid type entry (use Name, Name@version or Name:weight)')};
for(const n of nodes.values()){if(n.cfg&&n.cfg.types)tyOk(n.cfg.types,'node "'+n.name+'" cfg.types');if(n.cfg&&n.cfg.contract)tyOk(n.cfg.contract,'node "'+n.name+'" cfg.contract')}

/* edges */
const tmp={nodes:[...nodes.values()],edges:[]},edges=new Map();
for(const e of m.edges){const what='edge '+e.id+' ('+nm(e.from)+' → '+nm(e.to)+')';idOk(e.id,'e',what);
 const a=nodes.get(e.from),b=nodes.get(e.to);if(!a||!b){err(what+': from/to must be ids of existing nodes');continue}
 e.cfg=e.cfg||{};const ka=E.KIND(a),kb=E.KIND(b);
 if(e.cfg.table){const owner=ka==='store'?a:kb==='store'?b:null;if(!owner||!E.tableOf(owner,e.cfg.table)){err(what+': cfg.table "'+e.cfg.table+'" is not a table of '+(owner?owner.name:'a database on this edge'));continue}}
 const why=E.canConnect(tmp,a,b,e.cfg.table);if(why){err(what+': '+why);continue}
 for(const key in e.cfg)if(!['latency','table','sub','poll','types','pkey','pkeyN'].includes(key))warn(what+': cfg.'+key+' is not a connection setting and will be ignored');
 if(e.cfg.pkey!=null){if(!['entity','none','coarse'].includes(e.cfg.pkey))err(what+': cfg.pkey must be entity, none or coarse');if(kb!=='log')warn(what+': cfg.pkey only applies to connections into a topic or stream')}
 if(e.cfg.types){tyOk(e.cfg.types,what+' cfg.types');if(!(kb==='service'&&(['log','queue','pubsub'].includes(ka)||ka==='store')))warn(what+': cfg.types (a consumer-side filter) only applies to connections from a topic, queue, pub/sub or table into a service')}
 if(e.cfg.sub&&!(ka==='log'||ka==='queue'))warn(what+': cfg.sub only applies to edges leaving a topic or queue');
 if(e.cfg.poll&&ka!=='store')warn(what+': cfg.poll only applies to edges leaving a database table');
 for(const key in e.cfg.sub||{})if(!(key in E.SUBD))warn(what+': sub.'+key+' is not a subscription setting');
 for(const key in e.cfg.poll||{})if(!(key in E.POLLD))warn(what+': poll.'+key+' is not a polling setting');
 for(const key in e.fault||{})if(!(key in E.EFDEF))warn(what+': fault.'+key+' is not a connection fault');
 tmp.edges.push(e);edges.set(e.id,e)}

/* actions: every edge leaving a service-kind node needs exactly one action on that node */
for(const n of nodes.values()){if(E.KIND(n)!=='service')continue;const what='node "'+n.name+'"',used=new Set();
 for(const a of (n.cfg&&n.cfg.actions)||[]){idOk(a.id,'a',what+' action');const e=edges.get(a.edge);
  if(!e||e.from!==n.id){err(what+': action '+a.id+' points at edge "'+a.edge+'", which does not leave this node');continue}
  if(used.has(a.edge))err(what+': two actions use edge '+a.edge);used.add(a.edge);
  for(const key in a)if(key!=='id'&&key!=='edge'&&!(key in E.ACTD))warn(what+': action '+a.id+' field "'+key+'" is not an action setting');
  const d=nodes.get(e.to),dk=E.KIND(d);
  if(a.types)tyOk(a.types,what+' action '+a.id+' types');if(a.as)tyOk(a.as,what+' action '+a.id+' as');
  if(a.guard&&dk!=='store')warn(what+': action '+a.id+' has guard:true but '+d.name+' is not a database');
  if(a.tx&&dk!=='store')warn(what+': action '+a.id+' has tx:true but '+d.name+' is not a database');
  if(a.outbox&&!['log','queue','pubsub'].includes(dk))warn(what+': action '+a.id+' has outbox:true but '+d.name+' is not a topic or queue');
  if(a.outbox&&![...edges.values()].some(x=>x.from===n.id&&E.KIND(nodes.get(x.to))==='store'))err(what+': action '+a.id+' uses the outbox, but this node writes to no database')}
 for(const e of edges.values())if(e.from===n.id&&!used.has(e.id))err(what+': edge '+e.id+' → '+nm(e.to)+' has no action in cfg.actions, so it would never be called');
 if(n.type==='poller'&&![...edges.values()].some(e=>e.to===n.id&&E.KIND(nodes.get(e.from))==='store'))warn(what+': a polling loop with no table connected to it never runs')}

/* reachability */
for(const n of nodes.values()){const k=E.KIND(n);if(k==='note')continue;const ins=[...edges.values()].some(e=>e.to===n.id),outs=[...edges.values()].some(e=>e.from===n.id);
 if(k==='producer'){if(!outs)err('node "'+n.name+'": a source with no outgoing edge fails every request')}
 else if(!ins)warn('node "'+n.name+'": nothing calls or feeds it');
 if((k==='proxy'||k==='log'||k==='queue'||k==='pubsub')&&!outs)warn('node "'+n.name+'": has no '+(k==='proxy'?'targets':'subscribers'))}

/* deployment hierarchy */
const dep=new Map();
for(const g of m.groups){const what='app "'+(g.name||g.id)+'"';idOk(g.id,'g',what);
 for(const k of ['x','y','w','h'])if(typeof g[k]!=='number')err(what+': needs numeric '+k);
 for(const key in g.cfg||{})if(!(key in E.GDEF))warn(what+': cfg.'+key+' is not an application setting');
 dep.set(g.id,E.GFDEF);
 if(!Array.isArray(g.clusters)||!g.clusters.length){warn(what+': no clusters given; one cluster with one server group and one instance will be created');continue}
 for(const c of g.clusters){idOk(c.id,'c',what+' cluster "'+c.name+'"');dep.set(c.id,E.CFDEF);
  if(!Array.isArray(c.sgs)||!c.sgs.length){err(what+' cluster "'+c.name+'": needs at least one server group in "sgs"');continue}
  let sum=0;for(const s of c.sgs){idOk(s.id,'v',what+' server group "'+s.name+'"');dep.set(s.id,E.SFDEF);sum+=+((s.cfg||{}).weight==null?100:s.cfg.weight)||0;
   for(const key in s.cfg||{})if(!(key in E.SGDEF))warn(what+' server group "'+s.name+'": cfg.'+key+' is not a server-group setting');
   if(!Array.isArray(s.regions)||!s.regions.length){err(what+' server group "'+s.name+'": needs at least one region');continue}
   for(const r of s.regions){idOk(r.id,'r',what+' region "'+r.name+'"');dep.set(r.id,E.RFDEF);if(!(r.instances>=1))err(what+' region "'+r.name+'": instances must be 1 or more')}}
  if(c.sgs.length>1&&sum!==100)err(what+' cluster "'+c.name+'": server-group weights add up to '+sum+', not 100')}}

/* scenarios */
const sgIds=new Set([...dep].filter(x=>x[1]===E.SFDEF).map(x=>x[0]));
for(const s of m.scenarios){const what='scenario "'+(s.name||s.id)+'"';idOk(s.id,'s',what);
 for(const id in s.faults||{}){const n=nodes.get(id),e=edges.get(id),def=n?E.FDEF[E.KIND(n)]:e?E.EFDEF:dep.get(id);
  if(!def){err(what+': fault target "'+id+'" does not exist');continue}
  for(const key in s.faults[id])if(!(key in def))err(what+': "'+key+'" is not a fault of '+(n?n.name:id))}
 for(const t of s.triggers||[]){
  if(t.group){if(!sgIds.has(t.group))err(what+': trigger group "'+t.group+'" is not a server-group id');
   if(!['kill','rolling','cutover','restore'].includes(t.what))err(what+': server-group trigger "'+t.what+'" is unknown');
   if(t.what==='cutover'){if(!sgIds.has(t.from))err(what+': cut-over "from" must be a server-group id');if(!['canary','bluegreen','highlander','ab','rollback'].includes(t.mode))err(what+': cut-over mode "'+t.mode+'" is unknown')}}
  else{if(!nodes.has(t.node))err(what+': trigger node "'+t.node+'" does not exist');if(!['crash','errOnce','rebalance','flush','burst','fire'].includes(t.what))err(what+': node trigger "'+t.what+'" is unknown')}}}

/* load exactly as the app does, then run it */
let ran=null;
if(!errs.length){try{const mm=E.normalize(JSON.parse(JSON.stringify(m)));
  const lost=m.nodes.length-mm.nodes.length,lostE=m.edges.length-mm.edges.length;if(lost||lostE)err('import would drop '+lost+' node(s) and '+lostE+' edge(s)');
  console.log('Applications and their members (membership is by position on the canvas):');
  if(!mm.groups.length)console.log('  (no application boxes)');
  for(const g of mm.groups){const mem=mm.nodes.filter(n=>n.group===g.id).map(n=>n.name);
   console.log('  '+g.name+': '+(mem.length?mem.join(', '):'EMPTY')+'   ['+g.clusters.map(c=>c.name+': '+c.sgs.map(s=>s.name+' '+s.cfg.weight+'% ×'+s.regions.reduce((a,r)=>a+r.instances,0)).join(', ')).join(' | ')+']');
   if(!mem.length)warn('app "'+g.name+'": no service, proxy, cache or scheduler has its centre inside the box')}
  const sim=new E.Sim(mm,{});sim.advance(30000);
  for(const n of mm.nodes)if(E.KIND(n)==='producer')n.fault.pause=true;
  sim.syncFaults();sim.advance(60000);
  ran={sim,mm};
 }catch(e){err('the simulator threw while running this system: '+(e&&e.stack||e))}}
if(ran){const {sim,mm}=ran;console.log('\nHealthy run, 30 s of traffic then drained (no faults applied):');
 for(const src in sim.A.by){const b=sim.A.by[src],n=mm.nodes.find(x=>x.id===src),okp=Math.round(100*b.ok/Math.max(1,b.done));
  const flags=E.AFLAGS.filter(f=>b[f]).map(f=>f+' '+b[f]).join(', ');
  console.log('  '+n.name.padEnd(28)+' sent '+String(b.created).padStart(6)+'  finished '+String(b.done).padStart(6)+'  ok '+String(okp).padStart(3)+'%'+(flags?'  anomalies: '+flags:''));
  if(!b.created)warn('source "'+n.name+'": sent nothing in 30 s');
  else if(b.done<b.created)warn('source "'+n.name+'": '+(b.created-b.done)+' request(s) never finished even with no faults (a blocked consumer, an undrained table, or a missing connection)');
  else if(okp<90)warn('source "'+n.name+'": only '+okp+'% succeed with no faults applied. Check capacity (concurrency ÷ latency), timeouts and rate limits against the offered rate');
  if(flags)warn('source "'+n.name+'": consistency anomalies with no faults applied ('+flags+'). This is either a real design weakness or a mapping mistake; say which in the report')}}
console.log('');
for(const w of warns)console.log('WARN   '+w);
for(const e of errs)console.log('ERROR  '+e);
console.log((errs.length?'FAILED':'OK')+': '+errs.length+' error(s), '+warns.length+' warning(s)');
process.exit(errs.length?1:0);
