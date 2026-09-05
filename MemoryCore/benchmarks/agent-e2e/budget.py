"""Transactional peak-price budget, without credentials or request contents."""
import json,sqlite3,time,uuid
from pathlib import Path
class Budget:
 def __init__(self,path,cap=200,model='deepseek-v4-flash'):
  if model not in ['deepseek-v4-flash','MiniMax-M3']:raise ValueError('Unpriced model')
  self.path=Path(path);self.path.parent.mkdir(parents=True,exist_ok=True);self.cap=cap;self.model=model
  with self.connect() as db:
   db.execute('BEGIN IMMEDIATE')
   db.execute('CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,run_id TEXT,started REAL,state TEXT,reserved REAL,charged REAL,usage TEXT)')
   if 'model' not in {r[1] for r in db.execute('PRAGMA table_info(calls)')}:db.execute("ALTER TABLE calls ADD COLUMN model TEXT DEFAULT 'deepseek-v4-flash'")
 def connect(self):return sqlite3.connect(self.path,timeout=60)
 def reserve(self,run_id,input_bytes,max_output):
  inp,out=(4.2,16.8) if self.model=='MiniMax-M3' else (3,9)
  amount=((input_bytes+4096)*inp+max_output*out)/1e6;key=uuid.uuid4().hex
  with self.connect() as db:
   db.execute('BEGIN IMMEDIATE')
   used=db.execute("SELECT coalesce(sum(CASE WHEN state='pending' THEN reserved ELSE charged END),0) FROM calls").fetchone()[0]
   if used+amount>self.cap:raise RuntimeError('Authorized CNY budget reached')
   db.execute('INSERT INTO calls(id,run_id,started,state,reserved,charged,usage,model) VALUES(?,?,?,?,?,?,?,?)',(key,run_id,time.time(),'pending',amount,0,'{}',self.model))
  return key,amount
 def settle(self,key,reserved,usage=None):
  if usage and isinstance(usage.get('prompt_tokens'),(int,float)) and isinstance(usage.get('completion_tokens'),(int,float)):
   total=usage['prompt_tokens'];hit=usage.get('prompt_cache_hit_tokens',(usage.get('prompt_tokens_details') or {}).get('cached_tokens',0)) or 0
   hit=max(0,min(total,hit))
   with self.connect() as db:model=db.execute('SELECT model FROM calls WHERE id=?',(key,)).fetchone()[0]
   inp,out,cached=(3,9,.1) if model=='deepseek-v4-flash' else ((2.1,8.4,.42) if total<=512000 else (4.2,16.8,.84))
   amount=(hit*cached+(total-hit)*inp+usage['completion_tokens']*out)/1e6
  else:amount=reserved
  with self.connect() as db:db.execute('UPDATE calls SET state=?,charged=?,usage=? WHERE id=?',('settled',amount,json.dumps(usage or {}),key))
  return amount
 def summary(self):
  with self.connect() as db:
   rows=db.execute('SELECT state,reserved,charged,usage FROM calls').fetchall()
  return {'capCny':self.cap,'pricing':'Published standard rates. DeepSeek Flash peak input 3/output 9/cache .1 CNY/M. MiniMax M3 <=512k input 2.1/output 8.4/cache .42, above 512k doubled. Usage estimate, not an invoice.','calls':len(rows),'chargedUpperCny':sum(r[2] for r in rows),'unsettledReservationsCny':sum(r[1] for r in rows if r[0]=='pending'),'usage':[json.loads(r[3]) for r in rows]}
