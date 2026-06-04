import os
import re
import json
import time
import sys
from datetime import datetime, date, timedelta, time as dt_time
from typing import List, Dict, Any, Optional, Union
import execjs
import requests
from parsel import Selector
from bs4 import BeautifulSoup, Tag
from selenium import webdriver
from selenium.webdriver.edge.options import Options
from tqdm import tqdm
import akshare as ak
import pandas as pd
import numpy as np

# 全局缓存交易日历（避免每次调用都请求）
_TRADE_CAL = None

# 适配当前项目根目录，同时兼容原 utils/js 放置方式。
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(CURRENT_DIR)
JS_PATH_CANDIDATES = [
    os.path.join(CURRENT_DIR, "同花顺.js"),
    os.path.join(BASE_DIR, "src", "utils", "js", "同花顺.js"),
]
JS_PATH = next((path for path in JS_PATH_CANDIDATES if os.path.exists(path)), JS_PATH_CANDIDATES[0])

# 【重要】只加载JS代码，不提前计算v
with open(JS_PATH, encoding="utf-8") as f:
    js_runtime = execjs.compile(f.read())

# ------------------------------
# ✅ 每次请求都自动获取最新的 v
# ------------------------------
def get_v():
    """每次都获取最新的 v 参数，永不失效"""
    return js_runtime.call("zy")

# 通用请求头模板（动态v，每次自动更新）
def get_base_headers():
    v = get_v()  # 每次都重新生成最新v
    return {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0",
        "cookie": f"_ga=GA1.1.1440588356.1776609561; spversion=20130314; u_ukey=A10702B8689642C6BE607730E11E6E4A; u_uver=1.0.0; u_dpass=YvmhznxkHJqy1Y5n%2Fwq31g7E48F40rIl6YEfXzpSfA47NMZWcvuDnD27Hk3Ska9AHi80LrSsTFH9a%2B6rtRvqGg%3D%3D; u_did=C8272049210D413DAABCB06E56E86765; u_ttype=WEB; userid=658321955; u_name=mo_658321955; escapename=mo_658321955; user_status=0; user=MDptb182NTgzMjE5NTU6Ok5vbmU6NTAwOjY2ODMyMTk1NTo3LDExMTExMTExMTExLDQwOzQ0LDExLDQwOzYsMSw0MDs1LDEsNDA7MSwxMDEsNDA7MiwxLDQwOzMsMSw0MDs1LDEsNDA7OCwwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMSw0MDsxMDIsMSw0MDoyNDo6OjY1ODMyMTk1NToxNzc2OTQyNjUxOjo6MTY2OTg4NDMwMDo2MDQ4MDA6MDoxNGY4MzJmMDgzZGU2MWE0NzUzZjE4MTEwMTEzZDI2ZGU6ZGVmYXVsdF81OjE%3D; ticket=c1f8b23f5721dac37112ca08ed5c28e0; utk=e95f27f211c31e35139826b541bbbfac; sess_tk=eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6InNlc3NfdGtfMSIsImJ0eSI6InNlc3NfdGsifQ.eyJqdGkiOiJkZTI2M2QxMTEwODFmMTUzNDcxYWU2M2QwODJmODM0ZjEiLCJpYXQiOjE3NzY5NDI2NTEsImV4cCI6MTc3NzU0NzQ1MSwic3ViIjoiNjU4MzIxOTU1IiwiaXNzIjoidXBhc3MuMTBqcWthLmNvbS5jbiIsImF1ZCI6IjIwMjAxMTE4NTI4ODkwNzIiLCJhY3QiOiJvZmMiLCJjdWhzIjoiYzE3YWY1NDk4ODAxMTI5NTUwMjBhNDBlMjJiYzczNjdiM2MyZGI3MzdiZmE1YjQ0ZmM4NDNlNDgyNWFlYTU0ZSJ9.8kT1hQRhPMJmeJg6uldG9cAw6MGs5lVPXXcwfxgJQ6f_ZY_LFu7Zm7uMFoKfECDejU12yHOb6HCZQYd3xwxZUA; cuc=zdrwhlfgq2z5; __utma=156575163.1440588356.1776609561.1776942457.1777113627.3; __utmz=156575163.1777113627.3.3.utmcsr=cn.bing.com|utmccn=(referral)|utmcmd=referral|utmcct=/; v={v}",
    }

# ------------------------------
# 通用工具函数
# ------------------------------
def parse_jsonp_greedy(jsonp_string: str) -> Dict[str, Any]:
    """使用贪婪模式解析JSONP"""
    pattern = r'\((.*)\)'
    match = re.search(pattern, jsonp_string, re.DOTALL)
    
    if not match:
        raise ValueError(f"未找到JSONP数据: {jsonp_string[:100]}...")
    
    json_str = match.group(1).strip()
    stack = []
    last_valid_brace = -1
    for i, char in enumerate(json_str):
        if char == '{':
            stack.append(char)
        elif char == '}':
            if stack and stack[-1] == '{':
                stack.pop()
                if not stack:
                    last_valid_brace = i
    
    if last_valid_brace != -1:
        json_str = json_str[:last_valid_brace + 1]
    else:
        if json_str.endswith(',"'):
            json_str = json_str[:-2] + '}'
        elif json_str.endswith(','):
            json_str = json_str[:-1] + '}'
    
    try:
        return json.loads(json_str)
    except json.JSONDecodeError as e:
        start = json_str.find('{')
        end = json_str.rfind('}')
        if start != -1 and end != -1 and end > start:
            json_str = json_str[start:end+1]
            return json.loads(json_str)
        raise ValueError(f"无法解析JSON: {e}\n字符串: {json_str}")

def is_today_trade_day_and_opened() -> tuple[bool, bool]:
    """判断今天是否为交易日且A股已开市"""
    today_str = date.today().strftime("%Y-%m-%d")
    now = datetime.now()
    current_time = now.time()

    df = ak.tool_trade_date_hist_sina()
    trade_days_set = set(df["trade_date"].astype(str).tolist())

    is_trade_day = today_str in trade_days_set
    market_open_time = dt_time(9, 30)
    is_opened = current_time >= market_open_time

    return is_trade_day, is_opened

def safe_float(value):
    try:
        return float(value) if value else 0.0
    except:
        return 0.0

def get_recent_trade_days(kline_count: int) -> List[str]:
    """根据K线数量获取最近有效交易日列表"""
    df = ak.tool_trade_date_hist_sina()
    df["trade_date"] = df["trade_date"].astype(str)
    all_trade_days = df["trade_date"].tolist()

    is_trade_day, is_opened = is_today_trade_day_and_opened()
    today_str = date.today().strftime("%Y-%m-%d")

    if not is_trade_day or not is_opened:
        end_index = len(all_trade_days) - 1
        for i, d in enumerate(all_trade_days):
            if d >= today_str:
                end_index = i - 1
                break
    else:
        end_index = len(all_trade_days) - 1
        for i, d in enumerate(all_trade_days):
            if d >= today_str:
                end_index = i
                break

    start_index = max(0, end_index - kline_count + 1)
    selected_days = all_trade_days[start_index:end_index + 1]

    if len(selected_days) < kline_count:
        pad = [selected_days[0]] * (kline_count - len(selected_days))
        selected_days = pad + selected_days

    return selected_days[-kline_count:]

# ------------------------------
# 1. 实时行情数据
# ------------------------------
def parse_stock_info(datas: Dict[str, Any]) -> Dict[str, Any]:
    """解析同花顺股票实时数据，包含行情+流通结构"""
    data = datas['items']
    price = safe_float(data["10"])
    total_shares = safe_float(data["402"])
    float_shares = safe_float(data["407"])

    float_ratio = (float_shares / total_shares) * 100
    nonfloat_ratio = 100 - float_ratio

    float_shares_yi = float_shares / 10**8
    total_shares_yi = total_shares / 10**8

    float_cap = safe_float(data["3541450"]) / 10**8
    total_cap = safe_float(data["3475914"]) / 10**8

    return {
        "股票名称": data["name"],
        "股票代码": data["5"],
        "当前价格": price,
        "涨跌幅(%)": safe_float(data["199112"]),
        "今开": safe_float(data["7"]),
        "最高": safe_float(data["8"]),
        "最低": safe_float(data["9"]),
        "昨收": safe_float(data["6"]),
        "成交量(万股)": safe_float(data["13"]) / 10**6,
        "成交额(亿元)": safe_float(data["19"]) / 10**8,
        "振幅(%)": round(safe_float(data["526792"]), 2),
        "换手率(%)": safe_float(data["1968584"]),
        "动态市盈率": safe_float(data["2942"]),
        "市净率": safe_float(data["1149395"]),
        "流通占比(%)": round(float_ratio, 2),
        "非流通占比(%)": round(nonfloat_ratio, 2),
        "流通股本(亿股)": round(float_shares_yi, 2),
        "总股本(亿股)": round(total_shares_yi, 2),
        "流通市值(亿元)": round(float_cap, 2),
        "总市值(亿元)": round(total_cap, 2),
        "交易状态": data["stockStatus"],
        "更新时间": data["updateTime"]
    }

def get_trading_data(stock_code: str) -> Dict[str, Any]:
    """获取单只股票实时行情数据"""
    url = f'https://d.10jqka.com.cn/v2/realhead/hs_{stock_code}/last.js'
    headers = {**get_base_headers(), "host": "d.10jqka.com.cn", "referer": "https://stockpage.10jqka.com.cn/"}
    
    try:
        res = requests.get(url=url, headers=headers, timeout=10)
        res.raise_for_status()
        json_data = parse_jsonp_greedy(res.text)
        return parse_stock_info(json_data)
    except Exception as e:
        raise RuntimeError(f"获取行情数据失败: {str(e)}")

# ------------------------------
# 2. 个股新闻数据
# ------------------------------
def convert_10jqka_url(original_url: Optional[str]) -> Optional[str]:
    """
    兼容 Python 3.9，自动生成 https://field.10jqka.com.cn/日期/cID.shtml
    当 original_url 为空或格式不对时，返回 None
    """
    if not original_url:
        return None
    try:
        parts = original_url.split('/')
        date_str = parts[-2]
        article_id = parts[-1].split('.')[0]
        real_url = f"https://field.10jqka.com.cn/{date_str}/c{article_id}.shtml"
        return real_url
    except Exception:
        return None

def get_news_data(html: str, stock_code: str) -> List[Dict[str, Any]]:
    """
    先dl逐条HEAD校验，不足再从所有ul.news_lists的li逐条HEAD校验，强制返回固定3条
    """
    sel = Selector(html)

    # 详情页请求头（和你主爬虫完全一致）
    DETAIL_HEADERS = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Host": "field.10jqka.com.cn",
        "Pragma": "no-cache",
        "Sec-CH-UA": '"Microsoft Edge";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0"
    }

    final = []
    need_num = 3

    # 1. 先提取 dl 列表，逐条HEAD校验
    dl_list = sel.xpath('//div[@class="newslist clearfix"]/dl')
    for dl in dl_list:
        if len(final) >= need_num:
            break
        title = dl.xpath('.//dt/a/@title').get()
        href = dl.xpath('.//dt/a/@href').get()
        date = dl.xpath('.//dt/span[@class="fr date"]/text()').get()
        preview = dl.xpath('.//dd[@class="hot_preview f14"]/p/text()').get()

        real_href = convert_10jqka_url(href)
        if not real_href:
            continue

        # HEAD请求校验
        try:
            r = requests.head(
                url=real_href,
                headers=DETAIL_HEADERS,
                timeout=5,
                allow_redirects=True
            )
            if r.status_code == 200:
                final.append({
                    "type": "dl",
                    "title": title,
                    "href": real_href,
                    "date": date,
                    "preview": preview
                })
        except Exception:
            continue

    # 2. 不足3条，从所有 ul.news_lists 下的 li 逐条拿、逐条HEAD校验
    if len(final) < need_num:
        li_list = sel.xpath('//ul[@class="news_lists"]/li')
        for li in li_list:
            if len(final) >= need_num:
                break
            li_title = li.xpath('.//a/@title').get()
            li_href = li.xpath('.//a/@href').get()
            li_span = li.xpath('.//a/span/text()').get()

            real_href = convert_10jqka_url(li_href)
            if not real_href:
                continue

            # 同样发HEAD校验
            try:
                r = requests.head(
                    url=real_href,
                    headers=DETAIL_HEADERS,
                    timeout=5,
                    allow_redirects=True
                )
                if r.status_code == 200:
                    final.append({
                        "type": "list",
                        "title": li_title,
                        "href": real_href,
                        "span_date": li_span
                    })
            except Exception:
                continue

    # 3. 仍不足，补空占位，强制凑够3条
    while len(final) < need_num:
        final.append({
            "type": "empty",
            "title": None,
            "href": None,
            "date": None,
            "preview": None,
            "span_date": None
        })

    return final

def get_stock_news(stock_code: str) -> List[Dict[str, Any]]:
    """获取个股新闻列表"""
    # 读取JS并获取v参数（和你主爬虫完全一致）
    try:
        v = get_v()
    except Exception as e:
        raise RuntimeError(f"JS加密参数获取失败: {str(e)}")

    url = f"https://stockpage.10jqka.com.cn/ajax/code/{stock_code}/type/news/"

    headers = {
        'cookie': f'_ga=GA1.1.1440588356.1776609561; spversion=20130314; u_ukey=A10702B8689642C6BE607730E11E6E4A; u_uver=1.0.0; u_dpass=YvmhznxkHJqy1Y5n%2Fwq31g7E48F40rIl6YEfXzpSfA47NMZWcvuDnD27Hk3Ska9AHi80LrSsTFH9a%2B6rtRvqGg%3D%3D; u_did=C8272049210D413DAABCB06E56E86765; u_ttype=WEB; userid=658321955; u_name=mo_658321955; escapename=mo_658321955; user_status=0; user=MDptb182NTgzMjE5NTU6Ok5vbmU6NTAwOjY2ODMyMTk1NTo3LDExMTExMTExMTExLDQwOzQ0LDExLDQwOzYsMSw0MDs1LDEsNDA7MSwxMDEsNDA7MiwxLDQwOzMsMSw0MDs1LDEsNDA7OCwwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMSw0MDsxMDIsMSw0MDoyNDo6OjY1ODMyMTk1NToxNzc2OTQyNjUxOjo6MTY2OTg4NDMwMDo2MDQ4MDA6MDoxNGY4MzJmMDgzZGU2MWE0NzUzZjE4MTEwMTEzZDI2ZGU6ZGVmYXVsdF81OjE%3D; ticket=c1f8b23f5721dac37112ca08ed5c28e0; utk=e95f27f211c31e35139826b541bbbfac; sess_tk=eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6InNlc3NfdGtfMSIsImJ0eSI6InNlc3NfdGsifQ.eyJqdGkiOiJkZTI2M2QxMTEwODFmMTUzNDcxYWU2M2QwODJmODM0ZjEiLCJpYXQiOjE3NzY5NDI2NTEsImV4cCI6MTc3NzU0NzQ1MSwic3ViIjoiNjU4MzIxOTU1IiwiaXNzIjoidXBhc3MuMTBqcWthLmNvbS5jbiIsImF1ZCI6IjIwMjAxMTE4NTI4ODkwNzIiLCJhY3QiOiJvZmMiLCJjdWhzIjoiYzE3YWY1NDk4ODAxMTI5NTUwMjBhNDBlMjJiYzczNjdiM2MyZGI3MzdiZmE1YjQ0ZmM4NDNlNDgyNWFlYTU0ZSJ9.8kT1hQRhPMJmeJg6uldG9cAw6MGs5lVPXXcwfxgJQ6f_ZY_LFu7Zm7uMFoKfECDejU12yHOb6HCZQYd3xwxZUA; cuc=zdrwhlfgq2z5; __utma=156575163.1440588356.1776609561.1776942457.1777113627.3; __utmz=156575163.1777113627.3.3.utmcsr=cn.bing.com|utmccn=(referral)|utmcmd=referral|utmcct=/; searchGuide=sg; historystock=000001%7C*%7C300905%7C*%7C301261%7C*%7C688808; cmsad_170_0=0; Hm_lvt_69929b9dce4c22a060bd22d703b2a280=1777336679,1777343342,1777358282,1777381393; Hm_lpvt_69929b9dce4c22a060bd22d703b2a280=1777381393; HMACCOUNT=C89B123865ABA64E; Hm_lvt_79f50e6c773c1abd9bc7fc109ef95d43=1777336685,1777343769,1777358332,1777381404; Hm_lvt_78c58f01938e4d85eaf619eae71b4ed1=1777336685,1777343770,1777358332,1777381404; Hm_lvt_22a3c65fd214b0d5fd3a923be29458c7=1777336685,1777343770,1777358332,1777381404; Hm_lvt_f79b64788a4e377c608617fba4c736e2=1777278514,1777336685,1777358332,1777381405; Hm_lpvt_79f50e6c773c1abd9bc7fc109ef95d43=1777381408; Hm_lpvt_22a3c65fd214b0d5fd3a923be29458c7=1777381416; Hm_lpvt_78c58f01938e4d85eaf619eae71b4ed1=1777381416; Hm_lpvt_f79b64788a4e377c608617fba4c736e2=1777381417; _ga_H2RK0R0681=GS2.1.s1777381395$o20$g1$t1777381470$j60$l0$h0; v={v}',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
        'host': 'stockpage.10jqka.com.cn',
        'referer': f'https://stockpage.10jqka.com.cn/{stock_code}/news/'
    }

    try:
        res = requests.get(url=url, headers=headers, timeout=10)
        res.raise_for_status()
        sel = Selector(res.text)
        html_text = sel.xpath('//*[@id="news"]/div[2]/div').get()

        if html_text is None:
            raise ValueError("未获取到新闻列表的HTML内容")

        return get_news_data(html=html_text, stock_code=stock_code)
    except Exception as e:
        raise RuntimeError(f"获取新闻列表失败: {str(e)}")

def get_news_detail(news_url: str) -> Dict[str, Any]:
    """
    获取新闻详情内容（完全使用你主爬虫的Selenium逻辑）
    含进度条、浏览器初始化、异常安全关闭
    """
    try:
        print("=" * 60)
        print("📌 程序启动成功")
        print("📌 Python 版本:", sys.version[:5])
        print("📌 正在准备 Edge 浏览器...\n")

        # 进度条
        for _ in tqdm(range(10), desc="🔧 初始化中", unit="step"):
            time.sleep(0.05)

        # Edge 配置（和你主爬虫完全一致）
        edge_options = Options()
        edge_options.add_argument("--no-sandbox")
        edge_options.add_argument("--disable-gpu")
        edge_options.add_argument("--disable-dev-shm-usage")
        edge_options.add_experimental_option("excludeSwitches", ["enable-automation"])
        edge_options.add_experimental_option('useAutomationExtension', False)

        driver = None
        driver = webdriver.Edge(options=edge_options)

        print(f"✅ 正在加载页面：{news_url[:60]}...")
        driver.get(news_url)

        # 等待页面渲染
        for i in tqdm(range(5), desc="⏳ 页面加载中", unit="s"):
            time.sleep(1)

        print("\n" + "="*60)
        print("📰 页面标题：", driver.title)
        print("="*60)

        # 提取正文
        paragraphs = driver.find_elements("tag name", "p")
        content = "\n".join([p.text.strip() for p in paragraphs if p.text.strip()])

        title = driver.title
        driver.quit()

        if not content:
            print("\n⚠️ 未找到正文，返回页面源码前2000字符")
            content = driver.page_source[:2000]

        return {"title": title, "content": content, "url": news_url}

    except Exception as e:
        if 'driver' in locals() and driver:
            driver.quit()
        raise RuntimeError(f"获取新闻详情失败: {str(e)}")


def get_detail_new_list(stock_code: str) -> list[dict[str, Any]]:
    new_list = get_stock_news(stock_code)
    detail_new_list = []
    for item in new_list:
        href = item['href']
        detail_new = get_news_detail(news_url=href)  # {"title":..., "content":...}
        detail_new_list.append({
            "title": detail_new["title"],
            "content": detail_new["content"],
            "previw": item.get("preview",""),
            "date": item.get("date","")  # 修正字段名
        })
    return detail_new_list

# ------------------------------
# 3. 基本面数据
# ------------------------------
def extract_performance_data(html_list: List[str]) -> List[Any]:
    html = html_list[0]
    pattern = r'id="yjycData".*?>(\[.*?\])</div>'
    match = re.search(pattern, html, re.DOTALL)
    if not match:
        return []
    try:
        return json.loads(match.group(1))
    except:
        return []

#新爬一个专门的财务网站，跟worth分离，worth只负责获取财务概况，专门的财务网站来获取财务数据
# def get_financial_analysis_data(stock_code):
#     url = "https://basic.10jqka.com.cn/000001/finance.html"
#     headers = {
#         'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
#         'cookie': f'_ga=GA1.1.1440588356.1776609561; spversion=20130314; u_ukey=A10702B8689642C6BE607730E11E6E4A; u_uver=1.0.0; u_dpass=YvmhznxkHJqy1Y5n%2Fwq31g7E48F40rIl6YEfXzpSfA47NMZWcvuDnD27Hk3Ska9AHi80LrSsTFH9a%2B6rtRvqGg%3D%3D; u_did=C8272049210D413DAABCB06E56E86765; u_ttype=WEB; userid=658321955; __utma=156575163.1440588356.1776609561.1776942457.1777113627.3; __utmz=156575163.1777113627.3.3.utmcsr=cn.bing.com|utmccn=(referral)|utmcmd=referral|utmcct=/; searchGuide=sg; _clck=17k8e36%7C2%7Cg5l%7C0%7C0; usersurvey=1; ttype=WEB; user=MDptb182NTgzMjE5NTU6Ok5vbmU6NTAwOjY2ODMyMTk1NTo3LDExMTExMTExMTExLDQwOzQ0LDExLDQwOzYsMSw0MDs1LDEsNDA7MSwxMDEsNDA7MiwxLDQwOzMsMSw0MDs1LDEsNDA7OCwwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMSw0MDsxMDIsMSw0MDoyNDo6OjY1ODMyMTk1NToxNzc3NTk2MDg0Ojo6MTY2OTg4NDMwMDo2MDQ4MDA6MDoxYzg4NDRkMjlkYjkzMGY2Mzc3NmM5YzhkNDkwMDdlMDk6ZGVmYXVsdF81OjE%3D; u_name=mo_658321955; escapename=mo_658321955; ticket=2833f147e29a1f2d003b39377ec5dba4; user_status=0; utk=50a7e15b87880f69d31a5b8eb6c7f794; sess_tk=eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiIsImtpZCI6InNlc3NfdGtfMSIsImJ0eSI6InNlc3NfdGsifQ.eyJqdGkiOiIwOTdlMDA0OThkOWM2Yzc3NjMwZjkzZGIyOTRkODRjODEiLCJpYXQiOjE3Nzc1OTYwODQsImV4cCI6MTc3ODIwMDg4NCwic3ViIjoiNjU4MzIxOTU1IiwiaXNzIjoidXBhc3MuMTBqcWthLmNvbS5jbiIsImF1ZCI6IjIwMjAxMTE4NTI4ODkwNzIiLCJhY3QiOiJvZmMiLCJjdWhzIjoiNDkyZDE2ZDBmYzY2ZDIyMTFiMDk5MWFlYzhhNjYzODM1MWZkYzVlZjlhZmYzMjE3OTFjMTcyYTJhNzZmNDExNiJ9.yr191QTcAPcJ36ns9gDQ_Fq3KqMPD9XvCVAdtsSJpT2YtlcE27gz1a-BiYNlzRfabDg4IcjjF401Syp2dpnMLQ; cuc=jdzpg1ktbd1c; historystock=000001%7C*%7C301599%7C*%7C000066%7C*%7C000050; Hm_lvt_69929b9dce4c22a060bd22d703b2a280=1777446295,1777516099,1777595509,1777621972; Hm_lpvt_69929b9dce4c22a060bd22d703b2a280=1777621972; HMACCOUNT=C89B123865ABA64E; _ga_H2RK0R0681=GS2.1.s1777621977$o30$g0$t1777621977$j60$l0$h0; Hm_lvt_78c58f01938e4d85eaf619eae71b4ed1=1777446335,1777516107,1777595515,1777621986; Hm_lpvt_78c58f01938e4d85eaf619eae71b4ed1=1777622000; reviewJump=nojump; v={get_v()}',
#         'host': 'basic.10jqka.com.cn',
#         'referer': 'https://stockpage.10jqka.com.cn/'
#     }
#     res = requests.get(url = url, headers = headers)
#     html = res.text
#     sel = Selector(html)
#     title_list = sel.xpath('//*[@id="cwzbTable"]/div[1]/div[1]/div[3]/table[2]/tbody')
#     data_list = sel.xpath('//*[@id="cwzbTable"]/div[1]/div[1]/div[4]/div/table[2]/tbody')
#     print(html)
#     financial_analysis_data = []
#     for title, data in (title_list, data_list):
    #     new_title = title.xpath('/tr[]')


def extract_finance_html(html: Union[str, Tag]) -> Dict[str, Any]:
    if isinstance(html, Tag):
        soup = html
    else:
        soup = BeautifulSoup(html, "html.parser")

    data = {}
    for tr in soup.find_all("tr"):
        th = tr.find("th", class_="tl")
        if not th:
            continue
        key = th.get_text(strip=True)
        tds = tr.find_all("td")
        row = []
        for td in tds:
            span = td.find("span")
            text = span.get_text(strip=True) if span else td.get_text(strip=True)
            row.append(text)
        data[key] = row
    return data

def get_fundamental_data(stock_code: str) -> Dict[str, Any]:
    url = f'https://basic.10jqka.com.cn/{stock_code}/worth.html'
    headers = {**get_base_headers(), "host": "basic.10jqka.com.cn", "referer": "https://stockpage.10jqka.com.cn/"}

    try:
        res = requests.get(url=url, headers=headers, timeout=10)
        res.encoding = 'gbk'
        res.raise_for_status()
        html = res.text
        selector = Selector(text=html)
        soup = BeautifulSoup(html, 'html.parser')

        for tip in soup.select(".tipbox"):
            tip.decompose()

        text_parts = selector.xpath('//*[@id="forecast"]/div[2]/p[1]//text()').getall()
        full_text = "".join(text_parts)
        clean_intro = full_text.replace("\t", "").replace("\n", "").strip()

        chart_parts = selector.xpath('//*[@id="forecast"]/div[2]/div[1]').getall()
        performance_data = extract_performance_data(chart_parts)

        precise_selector = "#forecastdetail > div.bd > table.m_table.m_hl.ggintro.ggintro_1.organData > tbody"
        tbody_element = soup.select_one(precise_selector)
        finance_data = extract_finance_html(tbody_element) if tbody_element else {}

        return {
            "公司简介": clean_intro,
            "业绩预测": performance_data,
            "财务数据": finance_data
        }
    except Exception as e:
        raise RuntimeError(f"获取基本面数据失败: {str(e)}")

# ------------------------------
# 4. 日线K线数据（已修复所有bug）
# ------------------------------
def get_price_data_from_json(json_data: Dict[str, Any], price_key: str = 'price') -> List[float]:
    if price_key not in json_data:
        raise KeyError(f"JSON数据中未找到'{price_key}'字段")

    price_value = json_data[price_key]
    if isinstance(price_value, list):
        return [float(x) for x in price_value if x is not None]

    if isinstance(price_value, str):
        price_str = price_value.strip()
        if price_str.startswith('[') and price_str.endswith(']'):
            price_str = price_str[1:-1]

        items = price_str.split(',')
        price_list = []
        for item in items:
            item = item.strip()
            try:
                price_list.append(float(item))
            except ValueError:
                price_list.append(0.0)
        return price_list

    raise TypeError(f"不支持的price类型: {type(price_value)}")

def get_volumn_data_from_json(json_data: Dict[str, Any], volumn_key: str = 'volumn') -> List[float]:
    if volumn_key not in json_data:
        raise KeyError(f"JSON数据中未找到'{volumn_key}'字段")

    vol_str = json_data[volumn_key].strip()
    items = vol_str.split(',')
    vol_list = []
    for item in items:
        item = item.strip()
        try:
            vol_list.append(float(item))
        except (ValueError, TypeError):
            vol_list.append(0.0)
    return vol_list

def process_price_data(price_list: List[float], volumn_list: List[float], price_factor: float = 100) -> List[Dict[str, Any]]:
    cleaned_prices = []
    for item in price_list:
        try:
            cleaned_prices.append(float(item))
        except:
            cleaned_prices.append(0.0)

    remainder = len(cleaned_prices) % 4
    if remainder != 0:
        cleaned_prices = cleaned_prices[:-remainder]

    kline_count = len(cleaned_prices) // 4
    trade_days = get_recent_trade_days(kline_count)

    cleaned_vol = []
    for v in volumn_list:
        try:
            cleaned_vol.append(float(v))
        except:
            cleaned_vol.append(0.0)

    if len(cleaned_vol) < kline_count:
        cleaned_vol += [0.0] * (kline_count - len(cleaned_vol))
    cleaned_vol = cleaned_vol[:kline_count]

    result = []
    for i in range(kline_count):
        p_start = i * 4
        group = cleaned_prices[p_start:p_start+4]
        real_vol = cleaned_vol[i] / 1000000
        dp = {
            "date": trade_days[i],
            "low": round(group[0] / price_factor, 2),
            "open": round((group[0] + group[1]) / price_factor, 2),
            "high": round((group[0] + group[2]) / price_factor, 2),
            "close": round((group[0] + group[3]) / price_factor, 2),
            "volume": round(real_vol, 1)
        }
        result.append(dp)

    return result

# ------------------------------
# ✅ 全套技术指标计算（已修复VR报错）
# ------------------------------
def calculate_all_indicators(dayline_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not dayline_data:
        return []

    df = pd.DataFrame(dayline_data)
    close = df['close'].values
    high = df['high'].values
    low = df['low'].values
    volume = df['volume'].values

    # 1. 均线
    df['ma5'] = df['close'].rolling(5).mean().round(2)
    df['ma10'] = df['close'].rolling(10).mean().round(2)
    df['ma20'] = df['close'].rolling(20).mean().round(2)
    df['ma60'] = df['close'].rolling(60).mean().round(2)
    df['ema12'] = df['close'].ewm(span=12, adjust=False).mean().round(2)
    df['ema26'] = df['close'].ewm(span=26, adjust=False).mean().round(2)

    # 2. MACD
    df['macd_dif'] = (df['ema12'] - df['ema26']).round(2)
    df['macd_dea'] = df['macd_dif'].ewm(span=9, adjust=False).mean().round(2)
    df['macd_bar'] = (2 * (df['macd_dif'] - df['macd_dea'])).round(2)

    # 3. 布林带
    df['middle'] = df['close'].rolling(20).mean().round(2)
    std20 = df['close'].rolling(20).std(ddof=0).round(2)
    df['upper'] = (df['middle'] + 2 * std20).round(2)
    df['lower'] = (df['middle'] - 2 * std20).round(2)

    # 4. RSI (避免除零)
    def rsi(series, n=6):
        change = series.diff()
        gain = change.mask(change < 0, 0)
        loss = -change.mask(change > 0, 0)
        avg_gain = gain.rolling(n).mean()
        avg_loss = loss.rolling(n).mean()
        # 当平均亏损为 0 时，设置 RS 为很大值（相当于 RSI=100），避免除零报错
        avg_loss_safe = avg_loss.replace(0, np.nan)   # 将 0 换成 NaN，避免除以 0 得到 inf
        rs = avg_gain / avg_loss_safe
        rsi_val = 100 - (100 / (1 + rs))
        # 若 avg_loss 原本为 0 且 avg_gain 也为 0，RSI 设为 50；若只有 avg_loss=0，则 RSI=100
        rsi_val[avg_loss == 0] = 100.0
        rsi_val[(avg_loss == 0) & (avg_gain == 0)] = 50.0
        return rsi_val.round(2)

    df['rsi6'] = rsi(df['close'], 6)
    df['rsi12'] = rsi(df['close'], 12)
    df['rsi24'] = rsi(df['close'], 24)

    # 5. KDJ
    low_list = pd.Series(low).rolling(9).min()
    high_list = pd.Series(high).rolling(9).max()
    # 防止高低价相等导致除零
    diff = high_list - low_list
    rsv = np.where(diff != 0, (close - low_list) / diff * 100, 50.0)   # 若相等则设为 50
    rsv = pd.Series(rsv, index=df.index)
    df['kdj_k'] = rsv.ewm(alpha=1/3, adjust=False).mean().round(2)
    df['kdj_d'] = df['kdj_k'].ewm(alpha=1/3, adjust=False).mean().round(2)
    df['kdj_j'] = (3 * df['kdj_k'] - 2 * df['kdj_d']).round(2)

    # 6. CCI (处理 md=0 的情况)
    tp = (df['high'] + df['low'] + df['close']) / 3
    ma = tp.rolling(20).mean()
    md = (tp - ma).abs().rolling(20).mean()
    # 当 md 为 0 时，CCI 设为 0（或 100，视需求而定）
    md_safe = md.replace(0, np.nan)
    cci_val = (tp - ma) / (0.015 * md_safe)
    cci_val[md == 0] = 0.0
    df['cci'] = cci_val.round(2)

    # 7. DMA
    df['dma'] = (df['close'].rolling(10).mean() - df['close'].rolling(50).mean()).round(2)
    df['ama'] = df['dma'].rolling(10).mean().round(2)

    # 8. VR (已处理分母为 0，保持不变)
    def vr_calc(close, vol, n=26):
        vr_list = []
        for i in range(len(close)):
            if i < n:
                vr_list.append(np.nan)
                continue
            up = 0.0
            down = 0.0
            same = 0.0
            for j in range(1, n):
                c = close[i - n + j]
                prev_c = close[i - n + j - 1]
                v = vol[i - n + j]
                if c > prev_c:
                    up += v
                elif c < prev_c:
                    down += v
                else:
                    same += v
            denom = down + same / 2
            if denom == 0:
                vr_list.append(100.0)
            else:
                vr_list.append(round((up + same / 2) / denom * 100, 2))
        return vr_list

    df['vr'] = vr_calc(close, volume)

    # 9. 量均线
    df['vol_ma5'] = df['volume'].rolling(5).mean().round(1)
    df['vol_ma10'] = df['volume'].rolling(10).mean().round(1)

    # --- 关键步骤：彻底清除 NaN，转为 None（JSON 可识别的 null） ---
    # 先将全体转成 object 类型，保证 None 不会被隐式转回 NaN
    df = df.astype(object)
    # 再替换所有 NaN 为 None
    df = df.where(pd.notnull(df), None)

    return df.to_dict('records')

# ------------------------------
# 主入口：获取日线 + 全套指标
# ------------------------------
def get_dayline_data(stock_code: str) -> List[Dict[str, Any]]:
    url = f'https://d.10jqka.com.cn/v6/line/hs_{stock_code}/01/all.js'
    headers = {
        **get_base_headers(),
        "host": "d.10jqka.com.cn",
        "referer": "https://stockpage.10jqka.com.cn/"
    }

    try:
        res = requests.get(url=url, headers=headers, timeout=10)
        res.raise_for_status()
        text = res.content.decode('utf-8')
        json_data = parse_jsonp_greedy(text)

        price_list = get_price_data_from_json(json_data, 'price')
        vol_list = get_volumn_data_from_json(json_data, 'volumn')
        dayline = process_price_data(price_list, vol_list, price_factor=100)
        dayline_with_indicators = calculate_all_indicators(dayline)
        return dayline_with_indicators
    except Exception as e:
        raise RuntimeError(f"获取日线数据失败: {str(e)}")

    
# ------------------------------
# 5. 首页热门股票（龙虎榜）
# ------------------------------
def parse_hot_stock_html(html: str, limit: int = 6) -> list[dict]:
    """
    解析同花顺龙虎榜热门股票
    :param html: 爬取到的网页html
    :param limit: 返回前N条，默认6条
    :return: 热门股票列表
    """
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    rows = soup.select(".twrap tbody tr")[:limit]

    stock_list = []
    for tr in rows:
        tds = tr.find_all("td")
        if len(tds) < 7:
            continue

        stock_info = {
            "股票代码": tds[1].get_text(strip=True),
            "股票名称": tds[2].get_text(strip=True),
            "现价": tds[3].get_text(strip=True),
            "涨跌幅": tds[4].get_text(strip=True),
            "成交金额": tds[5].get_text(strip=True),
            "净买入额": tds[6].get_text(strip=True)
        }
        stock_list.append(stock_info)

    return stock_list

_TRADE_CAL = None

def get_hot_stocks(limit: int = 6):
    """
    获取龙虎榜热门股票（智能日期判断 · 实盘版）
    规则：
    1. 交易日 09:30~15:00（盘中）→ 返回【上一交易日】数据
    2. 交易日 15:00 后（盘后）→ 返回【今日】数据
    3. 非交易日 → 返回【上一交易日】数据
    """
    # 全局交易日历缓存
    _TRADE_CAL = None

    def get_real_trade_date():
        global _TRADE_CAL
        now = datetime.now()
        today_date = now.date()
        current_time = now.time()
        
        # 数据更新时间点
        data_update_time = dt_time(17, 30)
        
        # 加载交易日历（仅首次加载）
        if _TRADE_CAL is None:
            df = ak.tool_trade_date_hist_sina()
            # 确保转为 datetime 类型，再取 date
            df["trade_date"] = pd.to_datetime(df["trade_date"])
            df["trade_date"] = df["trade_date"].dt.date
            _TRADE_CAL = df
        
        # 判断今天是否为交易日
        is_today_trade = today_date in _TRADE_CAL["trade_date"].values
        
        # 核心逻辑：只有交易日，并且当前时间在数据更新时间之后，才取今天的数据
        if is_today_trade and current_time >= data_update_time:
            target_date = today_date
        else:
            # 取小于等于今天的最大交易日
            # 这里注意：如果今天是交易日但数据未更新，也会走到这一步，返回上一个交易日
            all_prev_dates = _TRADE_CAL[_TRADE_CAL["trade_date"] <= today_date]["trade_date"]
            if not all_prev_dates.empty:
                target_date = all_prev_dates.max()
            else:
                # 如果没找到任何交易日，回退到前一天（理论上不应发生）
                target_date = today_date - timedelta(days=1)
        return target_date

    # 获取真实日期
    trade_date = get_real_trade_date()
    print(f"📅 获取龙虎榜日期：{trade_date}")

    url = f"https://data.10jqka.com.cn/ifmarket/lhbtable/stock/all/report/{trade_date}/tab/all/field/STOCKCODE/sort/asc/"
    headers = {
        **get_base_headers(),
        "host": "data.10jqka.com.cn",
        "referer": "https://data.10jqka.com.cn/market/longhu/"
    }

    try:
        res = requests.get(url, headers=headers, timeout=10)
        res.raise_for_status()
        return parse_hot_stock_html(res.text, limit=limit)
    except Exception as e:
        raise RuntimeError(f"获取热门股票失败: {str(e)}")
