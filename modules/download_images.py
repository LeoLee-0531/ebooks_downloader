import requests
import os
from .utils import format_page_number, ensure_dir, load_env, load_cookies


def download_chapter_images(chapter_name, start_page, next_chapter_start, output_dir='output'):
    """
    下載單一章節的所有圖片
    chapter_name: 章節資料夾名稱
    start_page: 本章節第一頁頁數（int）
    next_chapter_start: 下一章節第一頁頁數（int）
    output_dir: 輸出根目錄
    """
    url_template = load_env()
    cookies = load_cookies()
    images_root = os.path.join(output_dir, 'images')
    chapter_dir = os.path.join(images_root, chapter_name)
    ensure_dir(chapter_dir)

    first_img_page = start_page + 1
    last_img_page = next_chapter_start  # 不包含下一章節的第一頁

    img_idx = 1
    error_count = 0
    print(f"  下載 {chapter_name} 圖片中 ...")
    for page in range(first_img_page, last_img_page):
        page_str = format_page_number(page)
        url = url_template.replace('{page}', page_str)
        img_name = f"{format_page_number(img_idx)}.jpg"
        img_path = os.path.join(chapter_dir, img_name)
        try:
            resp = requests.get(url, cookies=cookies, timeout=20)
            if resp.status_code == 200 and resp.headers['Content-Type'].startswith('image'):
                with open(img_path, 'wb') as f:
                    f.write(resp.content)
            else:
                print(
                    f"    [錯誤] 頁數 {page} ({img_name}) 下載失敗，狀態碼: {resp.status_code}")
                error_count += 1
        except Exception as e:
            print(f"    [錯誤] 頁數 {page} ({img_name}) 下載異常: {e}")
            error_count += 1
        img_idx += 1
    print(f"  {chapter_name} 下載完成，錯誤數量：{error_count}")
