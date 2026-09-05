@echo off
cd C:\Users\ASUS\Downloads\ALARM\alarm-app
rm -f .git\index.lock
git init
git add -A
git commit -m "Initial alarm-app commit"
git branch -M main
git remote add origin https://github.com/Rishish322546/Alarm-App.git
git push -u origin main
echo "Push complete!"