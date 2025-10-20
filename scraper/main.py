import requests
import pandas as pd
from datetime import datetime
import os

# Cria pasta data se não existir
os.makedirs('data', exist_ok=True)

# Endpoint da busca avançada de FIIs
url = "https://statusinvest.com.br/category/advancedsearchresultpaginated?search=%7B%22Segment%22%3A%22%22%2C%22Gestao%22%3A%22%22%2C%22my_range%22%3A%220%3B20%22%2C%22dy%22%3A%7B%22Item1%22%3Anull%2C%22Item2%22%3Anull%7D%2C%22p_vp%22%3A%7B%22Item1%22%3Anull%2C%22Item2%22%3Anull%7D%7D&orderColumn=&isAsc=&page=0&take=100&CategoryType=2"

headers = {
    "accept": "application/json, text/javascript, */*; q=0.01",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
}

response = requests.get(url, headers=headers)
data_json = response.json()

# Extrai lista de FIIs
fiis = data_json.get('result', [])

# Cria DataFrame
df = pd.DataFrame(fiis)

# Salva CSV com data
today = datetime.today().strftime('%Y%m%d')
csv_path = f"data/fiis_{today}.csv"
df.to_csv(csv_path, index=False)

print(f"CSV gerado: {csv_path}")
