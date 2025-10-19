# Asset Price Inquiry

A field shortcut plugin for querying stock and fund prices in real-time.

## Features
- Stock price inquiry (supports Chinese A-shares, Hong Kong stocks, US stocks)
- Fund net asset value inquiry (supports Chinese mutual funds)
- Automatic encoding handling for Chinese characters
- Real-time price data from reliable sources

## Getting Started
- Run `npm install` to install dependencies
- Run `npm start` to start server
- Run `npm run dev` to test execute function
- Note: `config.json` in the project root is for local debug authorization example only and is not used in production.

## Usage
Enter stock codes like:
- Chinese A-shares: `sh000001`, `sz000001`
- Hong Kong stocks: `hk00700`
- US stocks: `usAAPL`
- Mutual funds: `000311`

- Note: The "Date" input is for scheduling/automation only and does not affect the price query date.

## Publish
Run `npm run pack` to create the package. 
- Default output: `output/output.zip`
- Your environment may also generate timestamped files (e.g. `output_YYYY_MM_DD__HH_MM_SS.zip`).