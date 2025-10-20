import requests
import pandas as pd

URL = "https://statusinvest.com.br/category/advancedsearchresultpaginated"
HEADERS = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "x-requested-with": "XMLHttpRequest",
    "user-agent": "Mozilla/5.0"
}
COOKIES = {
    # Coloque aqui os cookies válidos da sua sessão
}

def fetch_page(page):
    params = {
        "search": '{"Segment":"","Gestao":"","my_range":"0;20"}',
        "page": page,
        "take": 15,
        "CategoryType": 2
    }
    response = requests.get(URL, headers=HEADERS, cookies=COOKIES, params=params)
    return response.json()

all_data = []
for page in range(0, 10):  # Ajuste o range conforme a quantidade de páginas
    data = fetch_page(page)
    all_data.extend(data.get("data", []))

df = pd.DataFrame(all_data)
df.to_csv("fiis_statusinvest.csv", index=False)
print("Dados salvos em fiis_statusinvest.csv")
