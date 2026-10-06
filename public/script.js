document.addEventListener('DOMContentLoaded', () => {
    const searchBtn = document.getElementById('searchBtn');
    const customerIdInput = document.getElementById('customerId');
    const searchSection = document.getElementById('searchSection');
    const reportSection = document.getElementById('reportSection');
    const loading = document.getElementById('loading');

    const dispName = document.getElementById('dispName');
    const dispId = document.getElementById('dispId');
    const dispFat = document.getElementById('dispFat');
    const dispStatus = document.getElementById('dispStatus');
    const dispSignal = document.getElementById('dispSignal');

    const issueBtns = document.querySelectorAll('.issue-btn');
    const passwordBox = document.getElementById('passwordBox');
    const newPasswordInput = document.getElementById('newPassword');
    const submitBtn = document.getElementById('submitBtn');

    let currentCustomerData = null;
    let selectedIssue = '';

    // 🔘 Issue Button များနှိပ်သည့်အခါ
    issueBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            issueBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');

            selectedIssue = btn.getAttribute('data-issue');

            // Password change ဖြစ်ပါက Password Box ဖော်မည်
            if (selectedIssue.includes('Password change')) {
                passwordBox.classList.remove('hidden');
                newPasswordInput.focus();
            } else {
                passwordBox.classList.add('hidden');
                newPasswordInput.value = '';
            }
        });
    });

    // 🔍 Search Customer ID
    searchBtn.addEventListener('click', async () => {
        const id = customerIdInput.value.trim();
        if (!id) {
            alert('Customer ID ရိုက်ထည့်ပါ');
            return;
        }

        loading.classList.remove('hidden');
        reportSection.classList.add('hidden');

        try {
            const res = await fetch(`/api/get-customer/${encodeURIComponent(id)}`);
            const data = await res.json();

            loading.classList.add('hidden');

            if (data.success) {
                currentCustomerData = { ...data, inputId: id };
                dispName.textContent = data.username || '-';
                dispId.textContent = id.toUpperCase();
                dispFat.textContent = data.fatBox || '-';
                dispStatus.textContent = data.onuStatus || '-';
                dispSignal.textContent = data.signal && data.signal !== 'N/A' 
                    ? (data.signal.includes('dBm') ? data.signal : `${data.signal} dBm`)
                    : 'N/A';

                reportSection.classList.remove('hidden');
            } else {
                alert(data.message || 'Customer မတွေ့ရှိပါ');
            }
        } catch (err) {
            loading.classList.add('hidden');
            alert('Server နှင့် ချိတ်ဆက်ရာတွင် အမှားရှိနေပါသည်');
        }
    });

    // 📩 Submit Report
    submitBtn.addEventListener('click', async () => {
        if (!currentCustomerData) {
            alert('ကျေးဇူးပြု၍ Customer ID ကို ဦးစွာ စစ်ဆေးပေးပါ');
            return;
        }

        if (!selectedIssue) {
            alert('ကျေးဇူးပြု၍ ဖြစ်ပေါ်နေသော ပြဿနာတစ်ခုအား ရွေးချယ်ပေးပါ');
            return;
        }

        let finalIssue = selectedIssue;

        if (selectedIssue.includes('Password change')) {
            const pwd = newPasswordInput.value.trim();
            if (!pwd) {
                alert('ကျေးဇူးပြု၍ Password အသစ် ရိုက်ထည့်ပေးပါ');
                newPasswordInput.focus();
                return;
            }
            finalIssue = `Password change (New Password: ${pwd})`;
        }

        const payload = {
            customerId: currentCustomerData.inputId,
            customerName: currentCustomerData.username,
            fatBox: currentCustomerData.fatBox,
            onuStatus: currentCustomerData.onuStatus,
            signal: currentCustomerData.signal,
            issue: finalIssue
        };

        try {
            const res = await fetch('/api/submit-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await res.json();
            alert(result.message);

            if (result.success) {
                location.reload();
            }
        } catch (err) {
            alert('Report ပို့ရာတွင် အမှားရှိနေပါသည်');
        }
    });
});
