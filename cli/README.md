# cas-portfolio-analyzer (CLI)

Terminal analyzer for Indian mutual-fund CAS statements (CAMS/KFintech PDF via
[casparser](https://github.com/codereverser/casparser), or casparser JSON): AMFI category
bifurcation, latest-NAV gains, XIRR, 1Y/3Y/5Y CAGR, FIFO LTCG/STCG estimate, research links.

```bash
pip install git+https://github.com/myfinancialria/cas-portfolio-analyzer#subdirectory=cli
cas-analyzer report MyCAS.pdf -p MYPAN1234X --html report.html
```

Full documentation, and the browser-based version of the same tool, live in the
[project README](https://github.com/myfinancialria/cas-portfolio-analyzer).
Educational output — not SEBI-registered investment advice.
