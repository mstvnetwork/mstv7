from flask import Flask, jsonify
import requests
import re

app = Flask(__name__)

TARGET_URL = "https://www.hdmovie2.uk/khauf-2025-hindi-season-1-complete/"

@app.route("/fresh-m3u8-url", methods=["GET"])
def fresh_m3u8_url():
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        }
        response = requests.get(TARGET_URL, headers=headers, timeout=10)
        response.raise_for_status()
        html = response.text

        urls = re.findall(r'https?://[^"\'>\s]+\.m3u8', html)

        if not urls:
            return jsonify({"error": "No m3u8 URLs found"}), 404

        unique_urls = list(set(urls))

        return jsonify({"urls": unique_urls})

    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
