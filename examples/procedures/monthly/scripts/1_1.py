import json,sys
import openpyxl
a=json.load(sys.stdin)
wb=openpyxl.load_workbook(a["xlsx"], data_only=True)
ws=wb["sales"]
agg={}
period=None
for r in list(ws.rows)[1:]:
    d,p,q,amt=r[0].value,r[1].value,r[2].value,r[4].value
    ds=str(d)[:7]
    period=period or ds
    e=agg.setdefault(p,{"qty":0,"incl":0})
    e["qty"]+=q; e["incl"]+=amt
rows=[{"item":k,"qty":v["qty"],"ex":round(v["incl"]/1.1)} for k,v in sorted(agg.items())]
total=sum(r["ex"] for r in rows)
print(json.dumps({"summary":"agg %s total %d"%(period,total),"json":{"rows":rows,"total":total,"period":period}}))