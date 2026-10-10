"""M3.5 실사용 테스트 샘플 생성 (가짜 데이터, 결정적)."""
import os
from pptx import Presentation
from pptx.util import Inches
import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))

prs = Presentation()
prs.slide_width = Inches(13.33)
prs.slide_height = Inches(7.5)

# 1. 표지
s = prs.slides.add_slide(prs.slide_layouts[5])
s.shapes.title.text = "월간보고서 2026-09 (초안)"
s.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(1)).text_frame.text = "ProcForge M3.5 dogfood용 샘플"

# 2. 9월 실적 요약 (표)
s2 = prs.slides.add_slide(prs.slide_layouts[5])
s2.shapes.title.text = "9월 실적 요약"
rows = [["제품", "수량", "매출(부가세 포함)"],
        ["A", "120", "1,320,000"],
        ["B", "80", "880,000"]]
table = s2.shapes.add_table(len(rows), 3, Inches(1), Inches(1.5), Inches(8), Inches(2)).table
for i, row in enumerate(rows):
    for j, v in enumerate(row):
        table.cell(i, j).text = v

# 3. 전망 (빈 틀)
s3 = prs.slides.add_slide(prs.slide_layouts[5])
s3.shapes.title.text = "10월 전망"
s3.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(1)).text_frame.text = "(작성 예정)"

prs.save(os.path.join(HERE, "a.pptx"))

# 9월 실적 엑셀 (부가세 포함 금액)
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "sales"
ws.append(["일자", "제품", "수량", "단가", "금액(부가세포함)"])
data = [
    ("2026-09-03", "A", 40, 10000, 440000),
    ("2026-09-11", "A", 80, 10000, 880000),
    ("2026-09-05", "B", 30, 10000, 330000),
    ("2026-09-19", "B", 50, 10000, 550000),
]
for r in data:
    ws.append(list(r))
wb.save(os.path.join(HERE, "sales-2026-09.xlsx"))

# 10월 실적 엑셀 (M5-8, 부가세 포함 금액, 세전 역산이 정수로 떨어지도록 단가 11000)
wb10 = openpyxl.Workbook()
ws10 = wb10.active
ws10.title = "sales"
ws10.append(["일자", "제품", "수량", "단가", "금액(부가세포함)"])
data10 = [
    ("2026-10-04", "A", 40, 11000, 440000),
    ("2026-10-12", "A", 60, 11000, 660000),
    ("2026-10-07", "B", 20, 11000, 220000),
    ("2026-10-21", "B", 30, 11000, 330000),
]
for r in data10:
    ws10.append(list(r))
wb10.save(os.path.join(HERE, "sales-2026-10.xlsx"))
print("samples written: a.pptx, sales-2026-09.xlsx, sales-2026-10.xlsx")
